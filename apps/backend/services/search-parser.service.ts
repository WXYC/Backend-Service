/**
 * Parses playlist search query strings into structured conditions.
 *
 * Supports:
 * - Simple terms: `autechre` (searches all text fields)
 * - Field prefixes: `artist:autechre`, `song:poise`, `album:confield`, `label:warp`, `dj:jake`
 * - Date filters: `date:2024-06-15`, `dateRange:2024-01-01..2024-12-31`
 * - Boolean operators: `AND`, `OR`, `NOT`
 * - Exact match: `artist:"Cat Power"` (quoted values)
 */

export type SearchOperator = 'AND' | 'OR';

export type SearchField =
  | 'artist_name'
  | 'track_title'
  | 'album_title'
  | 'record_label'
  | 'dj_name'
  | 'add_time'
  | 'add_time_range'
  | 'all';

export type SearchCondition = {
  operator: SearchOperator;
  field: SearchField;
  value: string;
  exact: boolean;
  negated: boolean;
};

const FIELD_PREFIXES: Record<string, SearchField> = {
  'artist:': 'artist_name',
  'song:': 'track_title',
  'album:': 'album_title',
  'label:': 'record_label',
  'dj:': 'dj_name',
  'date:': 'add_time',
  'dateRange:': 'add_time_range',
};

const OPERATORS = ['AND', 'OR', 'NOT'] as const;

const DATE_PATTERN = /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/;

/** Parse a search query string into structured conditions. */
export function parseSearchQuery(q: string): SearchCondition[] {
  const trimmed = q.trim();
  if (!trimmed) return [];

  const tokens = tokenize(trimmed);
  return buildConditions(tokens);
}

// --- Tokenizer ---

type TokenType = 'OPERATOR' | 'FIELD_PREFIX' | 'QUOTED_VALUE' | 'BARE_VALUE';
type Token = { type: TokenType; value: string };

function tokenize(input: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;

  while (i < input.length) {
    // Skip whitespace
    if (input[i] === ' ') {
      i++;
      continue;
    }

    // Check for operators (AND, OR, NOT) — must be followed by space or end-of-string
    const operatorMatch = tryMatchOperator(input, i);
    if (operatorMatch) {
      tokens.push({ type: 'OPERATOR', value: operatorMatch });
      i += operatorMatch.length;
      continue;
    }

    // Check for field prefixes
    const prefixMatch = tryMatchFieldPrefix(input, i);
    if (prefixMatch) {
      tokens.push({ type: 'FIELD_PREFIX', value: prefixMatch });
      i += prefixMatch.length;
      continue;
    }

    // Check for quoted value
    if (input[i] === '"') {
      const end = input.indexOf('"', i + 1);
      if (end === -1) {
        // Unmatched quote — take rest of string as value
        tokens.push({ type: 'QUOTED_VALUE', value: input.slice(i + 1) });
        break;
      }
      tokens.push({ type: 'QUOTED_VALUE', value: input.slice(i + 1, end) });
      i = end + 1;
      continue;
    }

    // Bare value — scan to next whitespace
    const start = i;
    while (i < input.length && input[i] !== ' ') {
      i++;
    }
    tokens.push({ type: 'BARE_VALUE', value: input.slice(start, i) });
  }

  return tokens;
}

function tryMatchOperator(input: string, pos: number): string | null {
  for (const op of OPERATORS) {
    if (
      input.slice(pos, pos + op.length) === op &&
      (pos + op.length >= input.length || input[pos + op.length] === ' ')
    ) {
      return op;
    }
  }
  return null;
}

function tryMatchFieldPrefix(input: string, pos: number): string | null {
  for (const prefix of Object.keys(FIELD_PREFIXES)) {
    if (input.slice(pos, pos + prefix.length) === prefix) {
      return prefix;
    }
  }
  return null;
}

// --- Condition builder ---

function buildConditions(tokens: Token[]): SearchCondition[] {
  const conditions: SearchCondition[] = [];
  let currentOperator: SearchOperator = 'AND';
  let negated = false;
  let currentField: SearchField | null = null;
  let i = 0;

  while (i < tokens.length) {
    const token = tokens[i];

    if (token.type === 'OPERATOR') {
      if (token.value === 'NOT') {
        negated = true;
      } else {
        currentOperator = token.value as SearchOperator;
      }
      i++;
      continue;
    }

    if (token.type === 'FIELD_PREFIX') {
      currentField = FIELD_PREFIXES[token.value];
      i++;
      continue;
    }

    if (token.type === 'QUOTED_VALUE' || token.type === 'BARE_VALUE') {
      const value = token.value;
      if (!value) {
        // Empty value (e.g., field prefix with no following value) — skip
        currentField = null;
        i++;
        continue;
      }

      // Validate date values before accepting them
      if (currentField === 'add_time' && !DATE_PATTERN.test(value)) {
        currentField = null;
        currentOperator = 'AND';
        negated = false;
        i++;
        continue;
      }
      if (currentField === 'add_time_range') {
        const [start, end] = value.split('..');
        if (!start || !end || !DATE_PATTERN.test(start) || !DATE_PATTERN.test(end)) {
          currentField = null;
          currentOperator = 'AND';
          negated = false;
          i++;
          continue;
        }
      }

      conditions.push({
        operator: currentOperator,
        field: currentField ?? 'all',
        value,
        exact: token.type === 'QUOTED_VALUE',
        negated,
      });

      // Reset state for next condition
      currentOperator = 'AND';
      negated = false;
      currentField = null;
      i++;
      continue;
    }

    i++;
  }

  return conditions;
}
