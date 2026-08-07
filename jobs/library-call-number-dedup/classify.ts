/**
 * Pure classification core of the library-call-number-dedup job.
 *
 * A WXYC call number addresses a physical shelf slot: the artist's genre-scoped
 * code letters, a number, and an optional volume letter for a multi-disc set,
 * rendered "KE 7" or "KE 7 B". Nothing in the schema enforces that a slot is
 * used once, and `generateAlbumCodeNumber` picks MAX+1 with no lock, so slots
 * accumulated more than one release.
 *
 * Two rows sharing a slot are one of two very different things, and the whole
 * job turns on telling them apart:
 *
 *   - the same release entered twice, which merges; or
 *   - two different releases that collided, where one must be renumbered AND
 *     the disc physically relabelled.
 *
 * Comparing titles for equality gets this wrong by better than 2x, because a
 * release is routinely re-entered under a differently-decorated title:
 * `It's a Party 12"` and `It's a Party cd-single` are one record filed twice.
 * `titleKey` strips the decoration that distinguishes a pressing from a work so
 * those land together, and `classifySlot` merges them.
 *
 * No database access here — everything is a pure function over row shapes, so
 * the classification can be exercised exhaustively in unit tests without a
 * Postgres.
 */

/**
 * A format marking is a measurement — `12"`, `7 inch` — not the bare number.
 * Stripped from the raw title BEFORE tokenizing, because the quote is the only
 * thing distinguishing the marking from an ordinary number, and punctuation
 * removal destroys it. Stripping the bare digit instead folds `vol. 7` into
 * `vol. 12`, merging two real records; 7, 10 and 12 are all ordinary volume
 * numbers as well as disc sizes.
 */
const FORMAT_MARKING = /\b(?:7|10|12)\s*(?:"|''|”|″|-?\s*inch(?:es)?)\s*(?:x\s*\d+)?/gi;

/**
 * Word decoration that names a *pressing* rather than a *work*: format,
 * edition, pressing status, and the articles/conjunctions that come and go when
 * the same title is retyped.
 *
 * Deliberately absent: any bare number. Volume and part numbers are part of the
 * work's name — `Ethiopiques vol. 21` and `vol. 22` are different records, and
 * folding them together would delete a catalog row that has plays.
 */
const DECORATION =
  /^(?:cd|lp|ep|single|singles|maxi|remix|rmx|clean|dirty|lyric|version|reissue|remastered|extended|live|vinyl|bonus|tracks?|disc|promo|missing|double|fulllength)$|^(?:the|a|an|of|with|w|and)$/;

/** `Volume One` and `Volume 1` are the same record typed two ways. */
const NUMBER_WORDS: Readonly<Record<string, string>> = {
  one: '1',
  two: '2',
  three: '3',
  four: '4',
  five: '5',
  six: '6',
  seven: '7',
  eight: '8',
  nine: '9',
  ten: '10',
};

/**
 * Fold a title to the work it names: drop format markings, lower-case, drop
 * punctuation, spell numbers as digits, then drop word decoration. Returns ''
 * when a title is nothing but decoration, which callers must treat as "no
 * evidence" rather than as a match.
 */
export const titleKey = (title: string): string =>
  title
    .toLowerCase()
    .replace(FORMAT_MARKING, ' ')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .split(/\s+/)
    .map((t) => NUMBER_WORDS[t] ?? t)
    .filter((t) => t.length > 0 && !DECORATION.test(t))
    .join('');

/**
 * Character-level similarity in [0,1], used only to catch typos that survive
 * `titleKey` (`Starlight Walker` vs `Starlite Walker`). Longest-common-
 * subsequence over the folded keys — cheap, and the inputs are short titles.
 */
export const similarity = (a: string, b: string): number => {
  if (a === b) return 1;
  if (!a.length || !b.length) return 0;
  let prev = new Array<number>(b.length + 1).fill(0);
  for (let i = 1; i <= a.length; i++) {
    const cur = new Array<number>(b.length + 1).fill(0);
    for (let j = 1; j <= b.length; j++) {
      cur[j] = a[i - 1] === b[j - 1] ? prev[j - 1] + 1 : Math.max(prev[j], cur[j - 1]);
    }
    prev = cur;
  }
  return (2 * prev[b.length]) / (a.length + b.length);
};

/** Titles this close after folding are treated as the same release retyped. */
export const SIMILARITY_THRESHOLD = 0.85;

/** One `library` row competing for a slot, with its inbound reference weight. */
export interface SlotMember {
  id: number;
  album_title: string;
  /** Total rows across every FK site pointing at this row (see FK_TARGETS). */
  refs: number;
}

export type SlotVerdict =
  /**
   * At least one row is a re-entry of `survivorId` and merges into it.
   * `unresolvedIds` lists rows in the same slot that are NOT the same release —
   * empty for the ordinary two-row case. When it is non-empty the slot still
   * collides after the merge, and the remainder is a shelf question rather than
   * something to guess at.
   */
  | { kind: 'merge'; survivorId: number; loserIds: number[]; unresolvedIds: number[] }
  /** Genuinely different releases. One must move, and its disc relabelled. */
  | { kind: 'renumber'; keepId: number; moveId: number };

/**
 * Decide whether two rows in a slot are one release or two.
 *
 * Merge survivor is the row carrying the most references, then the longer title
 * (the fuller of two spellings of one name), then the lower id. Reference count
 * leads because the surviving row inherits the other's plays, rotation history,
 * and reviews; picking the better-referenced row keeps the repoint smaller and
 * leaves the id that downstream systems already know in place.
 *
 * A slot holding three or more rows merges every row that matches the survivor
 * and reports the rest as still-colliding, rather than guessing at a chain.
 */
export const classifySlot = (members: readonly SlotMember[]): SlotVerdict => {
  if (members.length < 2) {
    throw new Error(`classifySlot needs at least 2 members, got ${members.length}`);
  }

  const ranked = [...members].sort(
    (x, y) => y.refs - x.refs || y.album_title.length - x.album_title.length || x.id - y.id
  );
  const [survivor, ...rest] = ranked;
  const survivorKey = titleKey(survivor.album_title);

  const sameRelease = (m: SlotMember): boolean => {
    const key = titleKey(m.album_title);
    // A title that folds to nothing carries no evidence either way; treat it as
    // distinct so a bare "[EP]" is never silently merged into a real title.
    if (!key || !survivorKey) return false;
    if (key === survivorKey) return true;
    // Deliberately NOT a prefix test. One title being a prefix of another is
    // equally the signature of a twofer (`#1 Record` / `#1 Record & Radio
    // City`), a sequel, or an unrelated longer name, and merging on it deletes
    // a different album and reattaches its plays. Decoration is already gone by
    // this point, so a genuine re-entry folds to an EQUAL key; similarity only
    // has to cover typos (`Starlight` / `Starlite`). A truncated-title
    // duplicate that misses the threshold falls through to a renumber, which
    // costs a shelf visit but never destroys a row.
    return similarity(key, survivorKey) >= SIMILARITY_THRESHOLD;
  };

  const losers = rest.filter(sameRelease);
  if (losers.length > 0) {
    return {
      kind: 'merge',
      survivorId: survivor.id,
      loserIds: losers.map((m) => m.id),
      unresolvedIds: rest.filter((m) => !sameRelease(m)).map((m) => m.id),
    };
  }

  // At least one row in the slot is a different release. The row that moves is
  // the least-referenced one — fewest downstream links to disturb, and the
  // least-played disc is the one least likely to be off the shelf when the
  // librarian goes looking for it.
  const byRefsAsc = [...members].sort((x, y) => x.refs - y.refs || y.id - x.id);
  return { kind: 'renumber', keepId: byRefsAsc[byRefsAsc.length - 1].id, moveId: byRefsAsc[0].id };
};

/**
 * A renumber is only safe when the disc being moved is the ONLY copy of that
 * title on its shelf. When the same title already sits at another number,
 * giving this one a third address makes the shelf worse while still satisfying
 * uniqueness — and which copy is real is a question only the shelf can answer.
 * Those are held back for the librarian instead of being renumbered.
 */
export const hasTwinElsewhere = (
  moveTitle: string,
  slotNumber: number,
  shelf: ReadonlyArray<{ code_number: number; album_title: string }>
): boolean => {
  const key = titleKey(moveTitle);
  if (!key) return false;
  return shelf.some((r) => r.code_number !== slotNumber && titleKey(r.album_title) === key);
};
