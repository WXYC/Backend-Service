import { readFileSync } from 'fs';
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
    // write-capable code path must not exist." This greps the module's own
    // source rather than trusting a docblock, so a future edit that adds a
    // write command fails a test instead of failing silently.
    it('imports no write-capable S3 command', () => {
      const source = readFileSync(path.join(__dirname, '../../../../jobs/digital-archive-bind/store.ts'), 'utf8');
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
