/**
 * Per-store S3 command and key-prefix allowlist (BS#3462).
 *
 * Each store module declares the commands it may sign and the key prefixes it
 * may touch, and calls `assertAllowed` before presigning. Its test calls
 * `undeclaredS3Imports` on the module's source so that importing any other
 * command from `@aws-sdk/client-s3` fails a test rather than passing review.
 * Errors name the command, never the key or bucket.
 */

export interface StoreAllowlistConfig {
  /** Command class names, e.g. `GetObjectCommand`. */
  commands: readonly string[];
  /** Key prefixes, e.g. `posters/`. */
  keyPrefixes: readonly string[];
}

export interface StoreAllowlist {
  assertAllowed(command: { constructor: { name: string }; input: { Key?: string } }): void;
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
      const key = command.input.Key ?? '';
      if (key.split('/').includes('..') || !config.keyPrefixes.some((prefix) => key.startsWith(prefix))) {
        throw new Error("S3 key is outside this store's allowed prefixes");
      }
    },
  };
}

/**
 * Source-scan pattern for a store module's test: returns every name imported
 * from `@aws-sdk/client-s3` that is neither `S3Client` nor in `declared`.
 * Expect `[]`.
 */
export function undeclaredS3Imports(source: string, declared: readonly string[]): string[] {
  const imported = [...source.matchAll(/import\s*\{([^}]*)\}\s*from\s*'@aws-sdk\/client-s3'/g)].flatMap((m) =>
    m[1]
      .split(',')
      .map((name) => name.trim().replace(/^type\s+/, ''))
      .filter(Boolean)
  );
  return imported.filter((name) => name !== 'S3Client' && !declared.includes(name));
}
