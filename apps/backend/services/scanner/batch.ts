/**
 * Batch scan processing service.
 *
 * Manages batch jobs where multiple vinyl records are scanned in one request.
 * Each job contains multiple items, each processed sequentially through the
 * Gemini extraction pipeline.
 */

import { eq, asc, sql } from 'drizzle-orm';
import { db, scan_jobs, scan_results } from '@wxyc/database';
import { processImages } from './processor.js';
import { ScanContext } from './types.js';

/**
 * Describes a single item in a batch scan request.
 */
export interface BatchItem {
  imageCount: number;
  photoTypes: string[];
  context: ScanContext;
}

/**
 * Response from creating a batch job.
 */
export interface BatchJobCreated {
  jobId: string;
  status: 'pending';
  totalItems: number;
}

/**
 * Status of a single scan result within a batch job.
 */
export interface BatchResultStatus {
  itemIndex: number;
  status: string;
  extraction: unknown;
  matchedAlbumId: number | null;
  errorMessage: string | null;
}

/**
 * Full status of a batch job including all results.
 */
export interface BatchJobStatus {
  jobId: string;
  status: string;
  totalItems: number;
  completedItems: number;
  failedItems: number;
  results: BatchResultStatus[];
  createdAt: Date;
  updatedAt: Date;
}

/**
 * Create a new batch scan job.
 *
 * Inserts the job and result rows, then kicks off background processing
 * via setImmediate so the HTTP response returns immediately.
 *
 * @param userId - Authenticated user ID
 * @param items - Batch item descriptors (imageCount, photoTypes, context)
 * @param imageBuffers - All image buffers in order (consumed by items sequentially)
 * @returns Job ID and initial status
 */
export async function createBatchJob(
  userId: string,
  items: BatchItem[],
  imageBuffers: Buffer[]
): Promise<BatchJobCreated> {
  const jobId = crypto.randomUUID();

  // Insert the job row
  await db.insert(scan_jobs).values({
    id: jobId,
    user_id: userId,
    status: 'pending',
    total_items: items.length,
    completed_items: 0,
    failed_items: 0,
  });

  // Insert a result row for each item
  const resultRows = items.map((item, index) => ({
    job_id: jobId,
    item_index: index,
    status: 'pending' as const,
    context: item.context,
  }));
  await db.insert(scan_results).values(resultRows);

  // Fire-and-forget background processing
  setImmediate(() => {
    processJobItems(jobId, items, imageBuffers).catch((err) => {
      console.error(`[Scanner] Batch job ${jobId} failed unexpectedly:`, err);
    });
  });

  return {
    jobId,
    status: 'pending',
    totalItems: items.length,
  };
}

/**
 * Get the status of a batch job, including all individual results.
 *
 * Returns null if the job does not exist or does not belong to the given user
 * (ownership check prevents enumeration).
 *
 * @param jobId - The batch job UUID
 * @param userId - Authenticated user ID (ownership check)
 * @returns Job status with results, or null if not found/unauthorized
 */
export async function getJobStatus(jobId: string, userId: string): Promise<BatchJobStatus | null> {
  const jobs = await db.select().from(scan_jobs).where(eq(scan_jobs.id, jobId)).execute();

  if (jobs.length === 0) {
    return null;
  }

  const job = jobs[0];

  // Ownership check: return null (indistinguishable from not-found)
  if (job.user_id !== userId) {
    return null;
  }

  const results = await db
    .select()
    .from(scan_results)
    .where(eq(scan_results.job_id, jobId))
    .orderBy(asc(scan_results.item_index))
    .execute();

  return {
    jobId: job.id,
    status: job.status,
    totalItems: job.total_items,
    completedItems: job.completed_items,
    failedItems: job.failed_items,
    createdAt: job.created_at,
    updatedAt: job.updated_at,
    results: results.map((r) => ({
      itemIndex: r.item_index,
      status: r.status,
      extraction: r.extraction,
      matchedAlbumId: r.matched_album_id,
      errorMessage: r.error_message,
    })),
  };
}

/**
 * Process all items in a batch job sequentially.
 *
 * Updates job and result statuses as each item is processed.
 * On completion, sets the job status to 'completed' if any items succeeded,
 * or 'failed' if all items failed.
 *
 * @param jobId - The batch job UUID
 * @param items - Batch item descriptors
 * @param imageBuffers - All image buffers in order
 */
export async function processJobItems(jobId: string, items: BatchItem[], imageBuffers: Buffer[]): Promise<void> {
  // Mark job as processing
  await db
    .update(scan_jobs)
    .set({ status: 'processing', updated_at: new Date() })
    .where(eq(scan_jobs.id, jobId))
    .execute();

  let completedCount = 0;
  let failedCount = 0;
  let bufferOffset = 0;

  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    const itemImages = imageBuffers.slice(bufferOffset, bufferOffset + item.imageCount);
    bufferOffset += item.imageCount;

    // Mark this result as processing
    await db
      .update(scan_results)
      .set({ status: 'processing' })
      .where(sql`${scan_results.job_id} = ${jobId} AND ${scan_results.item_index} = ${i}`)
      .execute();

    try {
      const result = await processImages(itemImages, item.photoTypes, item.context);

      completedCount++;
      await db
        .update(scan_results)
        .set({
          status: 'completed',
          extraction: result.extraction,
          matched_album_id: result.matchedAlbumId ?? null,
          completed_at: new Date(),
        })
        .where(sql`${scan_results.job_id} = ${jobId} AND ${scan_results.item_index} = ${i}`)
        .execute();

      await db
        .update(scan_jobs)
        .set({ completed_items: completedCount, updated_at: new Date() })
        .where(eq(scan_jobs.id, jobId))
        .execute();
    } catch (error) {
      failedCount++;
      const errorMessage = error instanceof Error ? error.message : String(error);
      console.error(`[Scanner] Batch item ${i} failed for job ${jobId}:`, errorMessage);

      await db
        .update(scan_results)
        .set({
          status: 'failed',
          error_message: errorMessage,
          completed_at: new Date(),
        })
        .where(sql`${scan_results.job_id} = ${jobId} AND ${scan_results.item_index} = ${i}`)
        .execute();

      await db
        .update(scan_jobs)
        .set({ failed_items: failedCount, updated_at: new Date() })
        .where(eq(scan_jobs.id, jobId))
        .execute();
    }
  }

  // Set final job status
  const finalStatus = completedCount > 0 ? 'completed' : 'failed';
  await db
    .update(scan_jobs)
    .set({ status: finalStatus, updated_at: new Date() })
    .where(eq(scan_jobs.id, jobId))
    .execute();
}
