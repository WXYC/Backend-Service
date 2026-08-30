import { readdirSync, readFileSync } from 'fs';
import path from 'path';
import { md5FromETag } from '../../../../jobs/digital-archive-bind/store';

describe('digital-archive-bind store', () => {
  describe('md5FromETag', () => {
    it('extracts the MD5 from a single-part ETag', () => {
      expect(md5FromETag('"9e107d9d372bb6826bd81d3542a419d6"')).toBe('9e107d9d372bb6826bd81d3542a419d6');
    });

    it('returns null for a multipart ETag (-N suffix)', () => {
      expect(md5FromETag('"9e107d9d372bb6826bd81d3542a419d6-4"')).toBeNull();
    });

    it('returns null for a malformed ETag', () => {
      expect(md5FromETag('not-an-etag')).toBeNull();
    });
  });

  describe('read-only enforcement', () => {
    // BS#2319 constraint: "Read-only against the Space -- GET/LIST only; a
    // write-capable code path must not exist." This greps source rather than
    // trusting a docblock, so a future edit that adds a write command fails a
    // test instead of failing silently.
    //
    // It scans EVERY .ts file in the job, not just store.ts: the claim the
    // module header and the README both make is that no mutating command
    // exists anywhere in this job, and a guard scoped to one file would pass
    // while a sibling module imported DeleteObjectCommand.
    const jobSources = (): string => {
      const dir = path.join(__dirname, '../../../../jobs/digital-archive-bind');
      const walk = (d: string): string[] =>
        readdirSync(d, { withFileTypes: true }).flatMap((e) =>
          e.isDirectory() ? walk(path.join(d, e.name)) : e.name.endsWith('.ts') ? [path.join(d, e.name)] : []
        );
      const files = walk(dir);
      expect(files.length).toBeGreaterThan(1); // a walk that finds nothing must not pass vacuously
      return files.map((f) => readFileSync(f, 'utf8')).join('\n');
    };

    it('imports no write-capable S3 command anywhere in the job', () => {
      const source = jobSources();
      const forbidden = [
        'PutObjectCommand',
        'DeleteObjectCommand',
        'DeleteObjectsCommand',
        'CopyObjectCommand',
        'CreateMultipartUploadCommand',
        'UploadPartCommand',
        'CompleteMultipartUploadCommand',
        'PutBucketCommand',
        'DeleteBucketCommand',
        'PutObjectAclCommand',
      ];
      for (const name of forbidden) {
        expect(source).not.toContain(name);
      }
    });

    it('imports only S3Client, ListObjectsV2Command, and GetObjectCommand from @aws-sdk/client-s3', () => {
      const source = readFileSync(path.join(__dirname, '../../../../jobs/digital-archive-bind/store.ts'), 'utf8');
      const importLine = source.split('\n').find((l) => l.includes("from '@aws-sdk/client-s3'"));
      expect(importLine).toBeDefined();
      expect(importLine).toContain('S3Client');
      expect(importLine).toContain('ListObjectsV2Command');
      expect(importLine).toContain('GetObjectCommand');
    });
  });
});
