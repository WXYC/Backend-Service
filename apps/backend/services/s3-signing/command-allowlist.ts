/**
 * Per-store S3 command and key-prefix allowlist (BS#3462).
 *
 * Each store module declares the commands it may sign or send and the key
 * prefixes it may touch, and calls `assertAllowed` before presigning or sending.
 * Its test calls `undeclaredImports` on the module's source so that importing
 * any other command from `@aws-sdk/client-s3` or `@aws-sdk/client-cloudfront`
 * fails a test rather than passing review.
 * Errors name the command, never the key or bucket.
 */

export interface StoreAllowlistConfig {
  /** Command class names, e.g. `GetObjectCommand`. */
  commands: readonly string[];
  /** Key prefixes, e.g. `posters/`. */
  keyPrefixes: readonly string[];
}

export interface StoreAllowlist {
  assertAllowed(command: {
    constructor: { name: string };
    input: { Key?: string; CopySource?: string; Bucket?: string };
  }): void;
}

export function defineStoreAllowlist(config: StoreAllowlistConfig): StoreAllowlist {
  for (const prefix of config.keyPrefixes) {
    if (!prefix.endsWith('/')) {
      throw new Error('S3 key prefix must be non-empty and end with "/"');
    }
  }
  return {
    assertAllowed(command) {
      const name = command.constructor.name;
      if (!config.commands.includes(name)) {
        throw new Error(`S3 command ${name} is not on this store's allowlist`);
      }
      const outside = (key: string) =>
        key.split('/').includes('..') || !config.keyPrefixes.some((prefix) => key.startsWith(prefix));
      if (outside(command.input.Key ?? '')) {
        throw new Error("S3 key is outside this store's allowed prefixes");
      }
      const { CopySource: source, Bucket: bucket } = command.input;
      if (source !== undefined) {
        // `[/]bucket/key[?versionId=...]`, with the key percent-encoded.
        const [bucketAndKey, ...rest] = source.split('?')[0].replace(/^\//, '').split('/');
        if (bucket !== undefined && bucketAndKey !== bucket) {
          throw new Error("S3 copy source is outside this store's bucket");
        }
        let key: string;
        try {
          key = decodeURIComponent(rest.join('/'));
        } catch {
          key = '';
        }
        if (outside(key)) {
          throw new Error("S3 copy source is outside this store's allowed prefixes");
        }
      }
    },
  };
}

// The client class of each scanned package is not a command and needs no declaration.
const CLIENT_CLASSES = ['S3Client', 'CloudFrontClient'];

/**
 * Source-scan pattern for a store module's test: returns every name imported
 * from `pkg` (e.g. `@aws-sdk/client-cloudfront`) that is neither a client class
 * nor in `declared`. Expect `[]`.
 */
export function undeclaredImports(source: string, pkg: string, declared: readonly string[]): string[] {
  const escaped = pkg.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');
  const imported = [...source.matchAll(new RegExp(`import\\s*\\{([^}]*)\\}\\s*from\\s*'${escaped}'`, 'g'))].flatMap(
    (m) =>
      m[1]
        .split(',')
        .map((name) => name.trim().replace(/^type\s+/, ''))
        .filter(Boolean)
  );
  return imported.filter((name) => !CLIENT_CLASSES.includes(name) && !declared.includes(name));
}

/** `undeclaredImports` for `@aws-sdk/client-s3`. */
export function undeclaredS3Imports(source: string, declared: readonly string[]): string[] {
  return undeclaredImports(source, '@aws-sdk/client-s3', declared);
}
