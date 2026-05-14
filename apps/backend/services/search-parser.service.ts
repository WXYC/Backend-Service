/**
 * Parses search query strings into structured conditions.
 *
 * Supports:
 * - Simple terms: `autechre` (searches all text fields)
 * - Field prefixes per the caller's config (e.g., `artist:autechre`, `album:confield`)
 * - Boolean operators: `AND`, `OR`, `NOT`
 * - Exact match: `artist:"Cat Power"` (quoted values)
 *
 * The parser is generic over the field set. Callers pass a {@link ParserConfig}
 * declaring their prefix map and (optional) per-field validators. Two named
 * configs ship in this module: {@link FLOWSHEET_PARSER_CONFIG} and
 * {@link CATALOG_PARSER_CONFIG}. Adding a third surface means a third
 * `*_PARSER_CONFIG` constant — the tokenizer and condition builder stay
 * field-agnostic.
 */

export type SearchOperator = 'AND' | 'OR';

/** Tokens the condition builder always produces, in addition to caller fields. */
export type IntrinsicField = 'all';

export type SearchCondition<F extends string = string> = {
  operator: SearchOperator;
  field: F | IntrinsicField;
  value: string;
  exact: boolean;
  negated: boolean;
};

export type ParserConfig<F extends string> = {
  /**
   * Maps a literal prefix (e.g., `'artist:'`) to a domain field token. The
   * prefix must end with `:` — the tokenizer matches the whole prefix
   * including punctuation.
   */
  fieldPrefixes: Record<string, F>;
  /**
   * Optional per-field value validators. When a validator returns `false` the
   * condition is dropped silently and the parser advances. Use this for
   * shape-constrained fields like dates.
   */
  validators?: Partial<Record<F, (value: string) => boolean>>;
};

const OPERATORS = ['AND', 'OR', 'NOT'] as const;

const DATE_PATTERN = /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/;

const isDate = (value: string): boolean => DATE_PATTERN.test(value);
const isDateRange = (value: string): boolean => {
  const [start, end] = value.split('..');
  return Boolean(start && end && isDate(start) && isDate(end));
};

export type FlowsheetField =
  | 'artist_name'
  | 'track_title'
  | 'album_title'
  | 'record_label'
  | 'dj_name'
  | 'add_time'
  | 'add_time_range';

export const FLOWSHEET_PARSER_CONFIG: ParserConfig<FlowsheetField> = {
  fieldPrefixes: {
    'artist:': 'artist_name',
    'song:': 'track_title',
    'album:': 'album_title',
    'label:': 'record_label',
    'dj:': 'dj_name',
    'date:': 'add_time',
    'dateRange:': 'add_time_range',
  },
  validators: {
    add_time: isDate,
    add_time_range: isDateRange,
  },
};

export type CatalogField = 'artist_name' | 'album_title' | 'label';

export const CATALOG_PARSER_CONFIG: ParserConfig<CatalogField> = {
  fieldPrefixes: {
    'artist:': 'artist_name',
    'album:': 'album_title',
    'label:': 'label',
  },
};

/** Parse a search query string into structured conditions. */
export function parseSearchQuery<F extends string>(q: string, config: ParserConfig<F>): SearchCondition<F>[] {
  const trimmed = q.trim();
  if (!trimmed) return [];

  const tokens = tokenize(trimmed, config);
  return buildConditions(tokens, config);
}

// --- Tokenizer ---

type TokenType = 'OPERATOR' | 'FIELD_PREFIX' | 'QUOTED_VALUE' | 'BARE_VALUE';
type Token = { type: TokenType; value: string };

function tokenize<F extends string>(input: string, config: ParserConfig<F>): Token[] {
  const tokens: Token[] = [];
  const prefixes = Object.keys(config.fieldPrefixes);
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
    const prefixMatch = tryMatchFieldPrefix(input, i, prefixes);
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

function tryMatchFieldPrefix(input: string, pos: number, prefixes: string[]): string | null {
  for (const prefix of prefixes) {
    if (input.slice(pos, pos + prefix.length) === prefix) {
      return prefix;
    }
  }
  return null;
}

// --- Condition builder ---

function buildConditions<F extends string>(tokens: Token[], config: ParserConfig<F>): SearchCondition<F>[] {
  const conditions: SearchCondition<F>[] = [];
  let currentOperator: SearchOperator = 'AND';
  let negated = false;
  let currentField: F | null = null;
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
      currentField = config.fieldPrefixes[token.value];
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

      // Validate field-shaped values before accepting them.
      if (currentField && config.validators?.[currentField] && !config.validators[currentField]!(value)) {
        currentField = null;
        currentOperator = 'AND';
        negated = false;
        i++;
        continue;
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
