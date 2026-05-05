/**
 * drizzle-kit's CLI spinner buffers Postgres ERROR text, so on migration
 * failure the deploy log carries only trailing NOTICE lines and operators
 * have to guess at cause. This helper exists so the programmatic migrate()
 * caller can dump the diagnostic fields (`severity`, `code`, `where`,
 * `detail`, `hint`) directly to stderr.
 *
 * drizzle-orm wraps Postgres errors in `DrizzleQueryError`, putting the
 * real PG error under `.cause`. Without walking that chain, the helper
 * sees only the wrapper's generic "Failed query: ..." message and misses
 * the very fields it exists to surface. The first object in the chain
 * carrying a non-message PG field is treated as the underlying error.
 */
const FIELD_ORDER = [
  'code',
  'severity',
  'message',
  'detail',
  'hint',
  'where',
  'schema',
  'table',
  'column',
  'constraint',
];

const PG_FIELDS = new Set(FIELD_ORDER);

function isPgError(value) {
  if (!value || typeof value !== 'object') return false;
  for (const field of PG_FIELDS) {
    if (field !== 'message' && value[field] !== undefined) return true;
  }
  return false;
}

function findPgErrorInChain(error) {
  let current = error;
  // Bound the walk; deeply-nested cause chains are pathological and we'd
  // rather fall back to the wrapper than loop on a malformed object graph.
  for (let depth = 0; depth < 10 && current; depth++) {
    if (isPgError(current)) return current;
    current = current.cause;
  }
  return null;
}

function dumpFields(target, lines) {
  for (const field of FIELD_ORDER) {
    const value = target[field];
    if (value !== undefined) {
      lines.push(`${field}: ${value}`);
    }
  }
}

export function formatPgError(error) {
  const lines = ['=== drizzle:migrate failed ==='];

  if (error && typeof error === 'object') {
    const pgError = findPgErrorInChain(error);
    if (pgError && pgError !== error) {
      // Wrapper carries useful context (e.g. "Failed query: <SQL>"), the
      // underlying PG error carries the diagnostic fields. Show both.
      if (error.message) lines.push(`wrapper: ${error.message}`);
      dumpFields(pgError, lines);
    } else {
      dumpFields(error, lines);
    }
    if (error.stack) {
      lines.push(`stack: ${error.stack}`);
    }
  } else {
    lines.push(String(error));
  }

  lines.push('===');
  return lines.join('\n') + '\n';
}
