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
    input: {
      Key?: string;
      CopySource?: string;
      Bucket?: string;
      InvalidationBatch?: { Paths?: { Items?: string[] } };
    };
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
      if (name === 'CreateInvalidationCommand') {
        // CloudFront paths start with "/" and may end in one "*"; map each onto a key prefix.
        // A wildcard must keep the whole allowed prefix before it, so `/p/*` passes for `p/` but `/p*` and `/*` do not.
        const items = command.input.InvalidationBatch?.Paths?.Items;
        const insidePrefixes = (item: string) => {
          if (!item.startsWith('/')) {
            return false;
          }
          let rest: string;
          try {
            // Decode before checking, as the CopySource branch does, so both agree on what a path names.
            rest = decodeURIComponent(item.slice(1));
          } catch {
            return false;
          }
          const base = rest.endsWith('*') ? rest.slice(0, -1) : rest;
          return !base.includes('*') && !outside(base);
        };
        if (!Array.isArray(items) || items.length === 0 || !items.every(insidePrefixes)) {
          throw new Error("CloudFront invalidation path is outside this store's allowed prefixes");
        }
        return;
      }
      if (outside(command.input.Key ?? '')) {
        throw new Error("S3 key is outside this store's allowed prefixes");
      }
      const { CopySource: source, Bucket: bucket } = command.input;
      if (source !== undefined) {
        // `[/]bucket/key[?versionId=...]`, with the key percent-encoded.
        const [bucketAndKey, ...rest] = source.split('?')[0].replace(/^\//, '').split('/');
        if (bucket === undefined || bucketAndKey !== bucket) {
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
 *
 * Covers named, default and namespace imports, `export ... from` re-exports,
 * `require()` and dynamic `import()`. A default import is reported as
 * `default`, a namespace or star re-export as `*`, and a `require()` or
 * `import()` of `pkg` as the call itself, since each exposes every command.
 * A `require()` or `import()` whose specifier is not a plain string literal is
 * reported as `require(<computed>)` / `import(<computed>)`: it may name `pkg`.
 * Type-only imports and side-effect imports bind no command and are skipped.
 */
export function undeclaredImports(source: string, pkg: string, declared: readonly string[]): string[] {
  const escaped = pkg.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');
  const staticForm = `\\b(?:import|export)\\s+((?:[\\w$]+\\s*,\\s*)?(?:\\*(?:\\s+as\\s+[\\w$]+)?|\\{[^}]*\\})|[\\w$]+)\\s*from\\s*(['"])${escaped}\\2`;
  const callForm = `(?<![.\\w$])(require|import)\\s*\\(\\s*(?:(['"])([^'"\\n]*)\\2\\s*\\))?`;
  const found: string[] = [];
  for (const [, clause] of source.matchAll(new RegExp(staticForm, 'g'))) {
    const bare = clause.replace(/\{[^}]*\}/, '');
    const namespace = /\*(\s+as\s+[\w$]+)?/.exec(bare);
    if (/[\w$]/.test(bare.replace(namespace?.[0] ?? '', ''))) {
      found.push('default');
    }
    if (namespace) {
      found.push('*');
    }
    const named = /\{([^}]*)\}/.exec(clause)?.[1] ?? '';
    for (const name of named.split(',')) {
      found.push(
        name
          .trim()
          .replace(/^type\s+/, '')
          .split(/\s+as\s+/)[0]
      );
    }
  }
  for (const [, fn, , specifier] of source.matchAll(new RegExp(callForm, 'g'))) {
    if (specifier === undefined) {
      found.push(`${fn}(<computed>)`);
    } else if (specifier === pkg) {
      found.push(`${fn}('${pkg}')`);
    }
  }
  return found.filter(Boolean).filter((name) => !CLIENT_CLASSES.includes(name) && !declared.includes(name));
}

/** `undeclaredImports` for `@aws-sdk/client-s3`. */
export function undeclaredS3Imports(source: string, declared: readonly string[]): string[] {
  return undeclaredImports(source, '@aws-sdk/client-s3', declared);
}
