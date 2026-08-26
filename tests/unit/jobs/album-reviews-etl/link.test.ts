/**
 * Unit tests for the album-reviews-etl library link pass: the pure
 * singleton-match decision (exactly one library match links; zero or many
 * never write), the two-tier exact-then-relaxed sweep (BS album-review
 * linkage widening), the single-sweep orchestration over injected loaders,
 * and the no-overwrite UPDATE guard (`WHERE album_id IS NULL` — manual
 * corrections always win).
 */
import { db, normalizeAlbumTitle } from '@wxyc/database';
import { renderSql } from '../../../utils/render-sql';
import {
  decideLink,
  loadCandidates,
  emptyLinkTotals,
  enrichCandidateRow,
  linkSubmissions,
  relaxedAlbumKey,
  textArrayLiteral,
  writeLink,
  type LibraryCandidate,
  type LibraryCandidateRow,
  type LinkTotals,
  type UnlinkedSubmission,
} from '../../../../jobs/album-reviews-etl/link';

type MockDb = typeof db & {
  _chain: {
    update: jest.Mock;
    set: jest.Mock;
    where: jest.Mock;
    returning: jest.Mock;
  };
};

const mockDb = db as MockDb;

const submission = (overrides: Partial<UnlinkedSubmission> = {}): UnlinkedSubmission => ({
  id: 1,
  norm_artist: 'juana molina',
  norm_album: normalizeAlbumTitle('DOGA'),
  ...overrides,
});

/** Builds the RAW sweep projection then runs it through the production
 *  enrichment, so every derived key (normalized/folded/relaxed) stays
 *  consistent with whatever the overrides set — a fixture that hand-set
 *  `norm_album_title` could silently disagree with `norm_primary`. */
const candidate = (overrides: Partial<LibraryCandidateRow> = {}): LibraryCandidate =>
  enrichCandidateRow({
    id: 501,
    album_title: 'DOGA',
    norm_primary: 'juana molina',
    norm_album_artist: '',
    norm_alternate: '',
    ...overrides,
  });

/** The all-zero totals shape, so a test naming one counter doesn't have to
 *  restate the other four. Built from the PRODUCTION factory, so a new
 *  counter cannot be added without every one of these assertions seeing it. */
const totalsShape = (overrides: Partial<LinkTotals> = {}): LinkTotals => ({
  ...emptyLinkTotals(),
  ...overrides,
});

describe('textArrayLiteral (BS#1068/BS#1071 single-param array binding)', () => {
  // Drizzle/postgres-js splats a JS array interpolated into a raw sql
  // fragment into N positional placeholders — `ANY(($1, $2))`, which PG
  // rejects. The repo idiom (album-level-backfill, alias-consumer) binds a
  // single PG-array-literal STRING param with an explicit cast. Those jobs
  // carry int[] (join is enough); norms are TEXT, so every element must be
  // double-quoted with backslash and quote escaping or a band name with a
  // comma/quote/brace corrupts the literal.
  it('quotes each element', () => {
    expect(textArrayLiteral(['juana molina', 'jessica pratt'])).toBe('{"juana molina","jessica pratt"}');
  });

  it('escapes embedded double quotes', () => {
    expect(textArrayLiteral(['the "5" royales'])).toBe('{"the \\"5\\" royales"}');
  });

  it('escapes backslashes before quotes (order matters)', () => {
    expect(textArrayLiteral(['ac\\dc'])).toBe('{"ac\\\\dc"}');
  });

  it('keeps commas and braces inert inside the quoted element', () => {
    expect(textArrayLiteral(['medeski, martin & wood', 'x{y}z'])).toBe('{"medeski, martin & wood","x{y}z"}');
  });

  it('renders an empty array as {}', () => {
    expect(textArrayLiteral([])).toBe('{}');
  });
});

describe('decideLink (pure singleton rule)', () => {
  it('links when exactly one library row matches artist AND album', () => {
    expect(decideLink(submission(), [candidate()], 'exact')).toEqual({ kind: 'linked', library_id: 501 });
  });

  it('reports unmatched when no candidate matches the album title', () => {
    expect(decideLink(submission(), [candidate({ album_title: 'Segundo' })], 'exact')).toEqual({ kind: 'unmatched' });
  });

  it('reports unmatched when the artist norms differ (candidate rows are a broad artist sweep)', () => {
    expect(
      decideLink(submission(), [candidate({ norm_primary: 'jessica pratt', norm_album_artist: '' })], 'exact')
    ).toEqual({
      kind: 'unmatched',
    });
  });

  it('reports ambiguous on two distinct matching library rows and links neither', () => {
    const decision = decideLink(submission(), [candidate({ id: 501 }), candidate({ id: 777 })], 'exact');
    expect(decision.kind).toBe('ambiguous');
  });

  it('matches through the album_artist leg too (compilations file the artist there)', () => {
    const viaAlbumArtist = candidate({ norm_primary: 'various artists', norm_album_artist: 'juana molina' });
    expect(decideLink(submission(), [viaAlbumArtist], 'exact')).toEqual({ kind: 'linked', library_id: 501 });
  });

  it('dedups a row matching via BOTH artist legs — still a singleton, not ambiguous', () => {
    const both = candidate({ norm_primary: 'juana molina', norm_album_artist: 'juana molina' });
    expect(decideLink(submission(), [both], 'exact')).toEqual({ kind: 'linked', library_id: 501 });
  });

  it('compares album titles through normalizeAlbumTitle (edition suffixes collapse)', () => {
    const deluxe = candidate({ album_title: 'DOGA (Deluxe Edition)' });
    expect(decideLink(submission(), [deluxe], 'exact')).toEqual({ kind: 'linked', library_id: 501 });
  });
});

describe('relaxedAlbumKey (the relaxed tier album leg)', () => {
  // Measured against prod 2026-08-25: punctuation + diacritics are the two
  // axes behind the bulk of the album-leg misses. This key is deliberately
  // NOT the persisted `norm_album` (which stays `normalizeAlbumTitle`) —
  // it is computed at match time on BOTH sides so nothing gets re-keyed.
  it.each([
    ['diacritics fold away', 'boleros psicodélicos', 'boleros psicodelicos'],
    ['NFD and NFC forms agree', 'nilüfer'.normalize('NFC'), 'nilufer'],
    ['apostrophes become separators', "i've got me", 'i ve got me'],
    ['slashes become separators', 'fake / fear', 'fake fear'],
    [
      'colons and parens collapse alike',
      'nerve bumps: a queer divine satisfaction',
      'nerve bumps a queer divine satisfaction',
    ],
    ['commas drop out', 'landwerk, no. 3', 'landwerk no 3'],
    ['runs of punctuation collapse to ONE separator', 'keep going ... under', 'keep going under'],
    ['trailing punctuation is trimmed', 'sounds like...', 'sounds like'],
    ['digits survive', '1971 - 1974', '1971 1974'],
    ['total on empty input', '', ''],
  ])('%s', (_label, input, expected) => {
    expect(relaxedAlbumKey(input)).toBe(expected);
  });

  it('is idempotent (re-relaxing an already-relaxed key is a no-op)', () => {
    const once = relaxedAlbumKey('nerve bumps: a queer divine satisfaction');
    expect(relaxedAlbumKey(once)).toBe(once);
  });

  it('does NOT collapse two genuinely different titles that differ by a word', () => {
    expect(relaxedAlbumKey('black metal 2')).not.toBe(relaxedAlbumKey('black metal'));
  });
});

describe('decideLink relaxed tier (widening, BS album-review linkage)', () => {
  // Every case below is drawn from the measured prod residue. The relaxed
  // tier NEVER fires on its own in production — `linkSubmissions` runs the
  // exact tier first and only falls through on a non-link.

  it('links through alternate_artist_name (the library co-files collaborations)', () => {
    // "The Smile — Wall of Eyes" is filed under Thom Yorke with the band in
    // alternate_artist_name; the physical record IS that library row.
    const coFiled = candidate({ norm_primary: 'thom yorke', norm_alternate: 'smile', album_title: 'Wall of Eyes' });
    const sub = submission({ norm_artist: 'smile', norm_album: normalizeAlbumTitle('Wall of Eyes') });
    expect(decideLink(sub, [coFiled], 'relaxed')).toEqual({ kind: 'linked', library_id: 501 });
    expect(decideLink(sub, [coFiled], 'exact')).toEqual({ kind: 'unmatched' });
  });

  it('links through a diacritic difference on the artist leg', () => {
    const folded = candidate({ norm_primary: 'hermanos gutierrez', album_title: 'Sonido Cosmico' });
    const sub = submission({ norm_artist: 'hermanos gutiérrez', norm_album: normalizeAlbumTitle('Sonido Cosmico') });
    expect(decideLink(sub, [folded], 'relaxed')).toEqual({ kind: 'linked', library_id: 501 });
    expect(decideLink(sub, [folded], 'exact')).toEqual({ kind: 'unmatched' });
  });

  it('links through a diacritic difference on the album leg', () => {
    const folded = candidate({ norm_primary: 'marcos valle', album_title: 'Tunel Acustico' });
    const sub = submission({ norm_artist: 'marcos valle', norm_album: normalizeAlbumTitle('Túnel Acústico') });
    expect(decideLink(sub, [folded], 'relaxed')).toEqual({ kind: 'linked', library_id: 501 });
    expect(decideLink(sub, [folded], 'exact')).toEqual({ kind: 'unmatched' });
  });

  it('links through a punctuation difference on the album leg (colon vs parenthetical)', () => {
    const punct = candidate({ norm_primary: 'dax pierson', album_title: 'Nerve Bumps: a queer divine satisfaction' });
    const sub = submission({
      norm_artist: 'dax pierson',
      norm_album: normalizeAlbumTitle('Nerve Bumps (A Queer Divine Satisfaction)'),
    });
    expect(decideLink(sub, [punct], 'relaxed')).toEqual({ kind: 'linked', library_id: 501 });
    expect(decideLink(sub, [punct], 'exact')).toEqual({ kind: 'unmatched' });
  });

  it('still reports ambiguous — never picks a winner — when the relaxed key hits two rows', () => {
    const a = candidate({ id: 501, norm_primary: 'pote', album_title: 'A Tenuous Tale Of Her' });
    const b = candidate({ id: 777, norm_primary: 'pote', album_title: 'A tenuous tale of Her!' });
    const sub = submission({ norm_artist: 'poté', norm_album: normalizeAlbumTitle('A Tenuous Tale Of Her') });
    expect(decideLink(sub, [a, b], 'relaxed')).toEqual({ kind: 'ambiguous', library_ids: [501, 777] });
  });

  it('does NOT link a sequel/volume title to its base record (why no fuzzy tier)', () => {
    // Measured false positives at trigram similarity 0.84-0.88. Relaxation is
    // punctuation/diacritics only, so these stay correctly unmatched.
    const base = candidate({ norm_primary: 'dean blunt', album_title: 'Black Metal' });
    const sub = submission({ norm_artist: 'dean blunt', norm_album: normalizeAlbumTitle('Black Metal 2') });
    expect(decideLink(sub, [base], 'relaxed')).toEqual({ kind: 'unmatched' });
  });

  it('never matches on an EMPTY artist leg (59,461 library rows carry an empty alternate_artist_name)', () => {
    // Without the empty guard an empty-normalizing submission would match the
    // whole library on the all-empty album_artist / alternate legs.
    const blankLegs = candidate({ norm_primary: 'juana molina', norm_album_artist: '', norm_alternate: '' });
    const blankSub = submission({ norm_artist: '', norm_album: normalizeAlbumTitle('DOGA') });
    expect(decideLink(blankSub, [blankLegs], 'relaxed')).toEqual({ kind: 'unmatched' });
    expect(decideLink(blankSub, [blankLegs], 'exact')).toEqual({ kind: 'unmatched' });
  });
});

describe('linkSubmissions (orchestration over injected deps)', () => {
  it('counts linked / link_ambiguous / link_unmatched and writes ONLY singletons', async () => {
    const writes: Array<[number, number]> = [];
    const totals = await linkSubmissions({
      loadUnlinked: () =>
        Promise.resolve([
          submission({ id: 1, norm_artist: 'juana molina' }),
          submission({ id: 2, norm_artist: 'stereolab', norm_album: normalizeAlbumTitle('Dots and Loops') }),
          submission({ id: 3, norm_artist: 'cat power', norm_album: normalizeAlbumTitle('Moon Pix') }),
        ]),
      loadCandidates: () =>
        Promise.resolve([
          candidate({ id: 501, norm_primary: 'juana molina', album_title: 'DOGA' }),
          candidate({ id: 601, norm_primary: 'stereolab', album_title: 'Dots and Loops' }),
          candidate({ id: 602, norm_primary: 'stereolab', album_title: 'Dots and Loops' }),
        ]),
      writeLink: (submissionId, libraryId) => {
        writes.push([submissionId, libraryId]);
        return Promise.resolve(true);
      },
    });

    expect(totals).toEqual(totalsShape({ linked: 1, linked_exact: 1, link_ambiguous: 1, link_unmatched: 1 }));
    expect(writes).toEqual([[1, 501]]);
  });

  it('passes each distinct norm_artist once per batch (no duplicate fan-out for multi-review artists)', async () => {
    const batches: string[][] = [];
    await linkSubmissions({
      loadUnlinked: () =>
        Promise.resolve([
          submission({ id: 1, norm_artist: 'juana molina' }),
          submission({ id: 2, norm_artist: 'juana molina', norm_album: normalizeAlbumTitle('Segundo') }),
          submission({ id: 3, norm_artist: 'jessica pratt', norm_album: normalizeAlbumTitle('Quiet Signs') }),
        ]),
      loadCandidates: (norms) => {
        batches.push([...norms]);
        return Promise.resolve([]);
      },
      writeLink: () => Promise.resolve(true),
    });

    const seen = batches.flat();
    expect(seen.filter((n) => n === 'juana molina')).toHaveLength(1);
    expect(seen.filter((n) => n === 'jessica pratt')).toHaveLength(1);
  });

  it('does not count a linked row when the guarded UPDATE reports no write (row linked out-of-band mid-run)', async () => {
    const totals = await linkSubmissions({
      loadUnlinked: () => Promise.resolve([submission({ id: 1 })]),
      loadCandidates: () => Promise.resolve([candidate({ id: 501 })]),
      writeLink: () => Promise.resolve(false), // WHERE album_id IS NULL matched nothing
    });
    expect(totals).toEqual(totalsShape());
  });

  it('returns zeros for an empty unlinked set without loading candidates', async () => {
    const loadCandidates = jest.fn();
    const totals = await linkSubmissions({
      loadUnlinked: () => Promise.resolve([]),
      loadCandidates,
      writeLink: () => Promise.resolve(true),
    });
    expect(totals).toEqual(totalsShape());
    expect(loadCandidates).not.toHaveBeenCalled();
  });

  it('splits the linked counter into linked_exact + linked_relaxed, and `linked` stays the total', async () => {
    const totals = await linkSubmissions({
      loadUnlinked: () =>
        Promise.resolve([
          submission({ id: 1, norm_artist: 'juana molina', norm_album: normalizeAlbumTitle('DOGA') }),
          submission({ id: 2, norm_artist: 'poté', norm_album: normalizeAlbumTitle('A Tenuous Tale Of Her') }),
        ]),
      loadCandidates: () =>
        Promise.resolve([
          candidate({ id: 501, norm_primary: 'juana molina', album_title: 'DOGA' }),
          candidate({ id: 502, norm_primary: 'pote', album_title: 'A tenuous tale of Her' }),
        ]),
      writeLink: () => Promise.resolve(true),
    });

    expect(totals).toEqual(totalsShape({ linked: 2, linked_exact: 1, linked_relaxed: 1 }));
  });

  it('runs the EXACT tier first: an exact singleton wins even when the relaxed key is ambiguous', async () => {
    // The measured prod case — two library rows for "Markolino Dimond —
    // Brujeria". The exact tier must still elect the one whose title matches
    // byte-for-byte rather than declining the pair as relaxed-ambiguous.
    const writes: Array<[number, number]> = [];
    const totals = await linkSubmissions({
      loadUnlinked: () =>
        Promise.resolve([
          submission({ id: 1, norm_artist: 'markolino dimond', norm_album: normalizeAlbumTitle('Brujeria') }),
        ]),
      loadCandidates: () =>
        Promise.resolve([
          candidate({ id: 501, norm_primary: 'markolino dimond', album_title: 'Brujeria' }),
          candidate({ id: 502, norm_primary: 'markolino dimond', album_title: 'Brujeria!' }),
        ]),
      writeLink: (submissionId, libraryId) => {
        writes.push([submissionId, libraryId]);
        return Promise.resolve(true);
      },
    });

    expect(writes).toEqual([[1, 501]]);
    expect(totals).toEqual(totalsShape({ linked: 1, linked_exact: 1 }));
  });

  it('counts a relaxed-tier multi-match as link_ambiguous and writes nothing', async () => {
    const writes: Array<[number, number]> = [];
    const totals = await linkSubmissions({
      loadUnlinked: () =>
        Promise.resolve([submission({ id: 1, norm_artist: 'poté', norm_album: normalizeAlbumTitle('Ahora Más') })]),
      loadCandidates: () =>
        Promise.resolve([
          candidate({ id: 501, norm_primary: 'pote', album_title: 'Ahora Mas' }),
          candidate({ id: 502, norm_primary: 'pote', album_title: 'Ahora, Mas!' }),
        ]),
      writeLink: (submissionId, libraryId) => {
        writes.push([submissionId, libraryId]);
        return Promise.resolve(true);
      },
    });

    expect(writes).toEqual([]);
    expect(totals).toEqual(totalsShape({ link_ambiguous: 1 }));
  });

  it('reports an EXACT-tier ambiguity even when the relaxed album key is empty', async () => {
    // The one shape where relaxed is not a coarsening of exact: a title made
    // entirely of separators. `normalizeAlbumTitle('!!!')` is `'!!!'` (a real
    // non-empty exact key — it is the !!! debut), but every character of it is
    // a separator to `relaxedAlbumKey`, so the relaxed key is ''. decideLink
    // declines an empty key, so the relaxed verdict is `unmatched` while the
    // exact verdict is a genuine two-row ambiguity. The run must count the
    // ambiguity, not report the row as unmatched.
    const dupeA = candidate({ id: 501, norm_primary: '!!!', album_title: '!!!' });
    const dupeB = candidate({ id: 502, norm_primary: '!!!', album_title: '!!!' });
    const sub = submission({ id: 1, norm_artist: '!!!', norm_album: normalizeAlbumTitle('!!!') });

    // Pin the premise, so this test fails loudly if the keys stop behaving
    // this way rather than silently testing nothing.
    expect(relaxedAlbumKey(normalizeAlbumTitle('!!!'))).toBe('');
    expect(decideLink(sub, [dupeA, dupeB], 'exact')).toEqual({ kind: 'ambiguous', library_ids: [501, 502] });
    expect(decideLink(sub, [dupeA, dupeB], 'relaxed')).toEqual({ kind: 'unmatched' });

    const writes: Array<[number, number]> = [];
    const totals = await linkSubmissions({
      loadUnlinked: () => Promise.resolve([sub]),
      loadCandidates: () => Promise.resolve([dupeA, dupeB]),
      writeLink: (submissionId, libraryId) => {
        writes.push([submissionId, libraryId]);
        return Promise.resolve(true);
      },
    });

    expect(writes).toEqual([]);
    expect(totals).toEqual(totalsShape({ link_ambiguous: 1 }));
  });

  it('reaches a candidate whose ONLY matching leg is alternate_artist_name (the +41-row axis)', async () => {
    // The largest measured relaxed axis, pinned END-TO-END rather than at
    // decideLink: the bucket index is the layer that can starve it. Drop
    // `norm_alternate`/`fold_alternate` from the index key set and this test
    // fails while every decideLink-level test still passes.
    const writes: Array<[number, number]> = [];
    const totals = await linkSubmissions({
      loadUnlinked: () =>
        Promise.resolve([submission({ id: 1, norm_artist: 'smile', norm_album: normalizeAlbumTitle('Wall of Eyes') })]),
      loadCandidates: () =>
        Promise.resolve([
          candidate({ id: 501, norm_primary: 'thom yorke', norm_alternate: 'smile', album_title: 'Wall of Eyes' }),
        ]),
      writeLink: (submissionId, libraryId) => {
        writes.push([submissionId, libraryId]);
        return Promise.resolve(true);
      },
    });

    expect(writes).toEqual([[1, 501]]);
    expect(totals).toEqual(totalsShape({ linked: 1, linked_relaxed: 1 }));
  });

  it('sweeps the library ONCE for both tiers (no second query for the relaxed pass)', async () => {
    const loadCandidates = jest.fn(() => Promise.resolve([]));
    await linkSubmissions({
      loadUnlinked: () =>
        Promise.resolve([
          submission({ id: 1, norm_artist: 'juana molina' }),
          submission({ id: 2, norm_artist: 'poté', norm_album: normalizeAlbumTitle('Ahora') }),
        ]),
      loadCandidates,
      writeLink: () => Promise.resolve(true),
    });
    expect(loadCandidates).toHaveBeenCalledTimes(1);
  });

  it('asks the sweep for the FOLDED norms as well, so the relaxed artist leg has candidates', async () => {
    let seenNorms: string[] = [];
    let seenFolded: string[] | undefined;
    await linkSubmissions({
      loadUnlinked: () => Promise.resolve([submission({ id: 1, norm_artist: 'hermanos gutiérrez' })]),
      loadCandidates: (norms, folded) => {
        seenNorms = [...norms];
        seenFolded = folded ? [...folded] : undefined;
        return Promise.resolve([]);
      },
      writeLink: () => Promise.resolve(true),
    });
    expect(seenNorms).toEqual(['hermanos gutiérrez']);
    expect(seenFolded).toEqual(['hermanos gutierrez']);
  });
});

describe('loadCandidates (the statement the job actually emits)', () => {
  // The widened sweep had no unit-level pin: `linkSubmissions` only ever sees
  // an injected `loadCandidates`, and the integration spec asserts a HAND-COPY
  // of this SQL, so a change here could leave both green while production
  // swept differently. Rendered through the repo's canonical `renderSql`
  // helper (the `flowsheet-no-match-recheck/query.test.ts` precedent).
  beforeEach(() => {
    (db.execute as jest.Mock).mockReset();
    (db.execute as jest.Mock).mockResolvedValue([]);
  });

  const sweepText = async (): Promise<string> => {
    await loadCandidates(['juana molina'], ['juana molina']);
    return renderSql((db.execute as jest.Mock).mock.calls[0]?.[0]).replace(/\s+/g, ' ');
  };

  it('sweeps library through both MATERIALIZED CTEs', async () => {
    const text = await sweepText();
    expect(text).toMatch(/FROM\s+"?\w+"?\."?library"?/i);
    expect(text).toContain('normalized AS MATERIALIZED');
    expect(text).toContain('folded AS MATERIALIZED');
  });

  it('normalizes all THREE artist legs, alternate_artist_name included', async () => {
    const text = await sweepText();
    for (const leg of ['artist_name', 'album_artist', 'alternate_artist_name']) {
      // Schema-qualified: `WXYC_SCHEMA_NAME` is what parallel Jest workers override.
      expect(text).toContain(`"normalize_artist_name"(coalesce("${leg}", ''))`);
    }
  });

  it('gates every fold on its leg being non-empty (a no-op that skips ~65% of the folds)', async () => {
    const text = await sweepText();
    for (const leg of ['norm_primary', 'norm_album_artist', 'norm_alternate']) {
      expect(text).toContain(`CASE WHEN ${leg} <> '' THEN`);
    }
  });

  it("guards every leg with <> '' so an empty probe norm cannot select the whole library", async () => {
    const text = await sweepText();
    expect(text).toContain(`(norm_primary <> ''`);
    expect(text).toContain(`(norm_album_artist <> ''`);
    expect(text).toContain(`(norm_alternate <> ''`);
  });

  it('binds ONE text[] literal per key space, never a splatted JS array', async () => {
    const text = await sweepText();
    // BS#1068/BS#1071: a bare JS array interpolated into a raw sql fragment is
    // splatted into N positional placeholders — `ANY(($1, $2))` — which PG
    // rejects. Every arm must bind ONE `text[]` array-literal instead.
    expect(text).not.toMatch(/ANY\(\(/);
    expect(text.match(/= ANY\(\{[^}]*\}::text\[\]\)/g) ?? []).toHaveLength(6);
    // Three legs x two key spaces, and the folded literal is genuinely distinct
    // from the norm literal (this probe folds to itself, so assert the binding
    // count rather than the values).
    expect(text).toContain(`fold_primary = ANY({"juana molina"}::text[])`);
  });

  it('projects only the normalized legs — the folds exist for the WHERE alone', async () => {
    const text = await sweepText();
    expect(text).toContain('SELECT "id", "album_title", norm_primary, norm_album_artist, norm_alternate FROM folded');
  });
});

describe('the coarsening invariant (why exact runs first)', () => {
  // The entire two-tier ordering rests on one property: the relaxed keys are a
  // strict coarsening of the exact keys, so anything the exact tier links is
  // still matched by the relaxed tier — EXCEPT when the relaxed album key
  // collapses to empty, which decideLink declines. Stated as a property here
  // so a future axis that breaks coarsening in a NEW way fails loudly, rather
  // than being witnessed by the two anecdotes that motivated it.
  it.each([
    ['plain ascii', 'juana molina', 'DOGA'],
    ['diacritic artist', 'hermanos gutierrez', 'Sonido Cosmico'],
    ['punctuated title', 'dax pierson', 'Nerve Bumps: a queer divine satisfaction'],
    ['comma title', 'jessica pratt', 'Landwerk, No. 3'],
    ['digits', 'dean blunt', 'Black Metal 2'],
    ['edition suffix', 'stereolab', 'Dots and Loops (Remastered)'],
    ['separators-only title', 'quintron', '!!!'],
  ])('exact-linked implies relaxed-matched, or an empty relaxed key: %s', (_label, artist, title) => {
    const c = candidate({ id: 501, norm_primary: artist, album_title: title });
    const sub = submission({ norm_artist: artist, norm_album: normalizeAlbumTitle(title) });

    const exact = decideLink(sub, [c], 'exact');
    expect(exact).toEqual({ kind: 'linked', library_id: 501 });

    const relaxed = decideLink(sub, [c], 'relaxed');
    if (relaxedAlbumKey(sub.norm_album) === '') {
      expect(relaxed).toEqual({ kind: 'unmatched' });
    } else {
      expect(relaxed).toEqual({ kind: 'linked', library_id: 501 });
    }
  });

  it('the relaxed tier never LINKS a row the exact tier called ambiguous', () => {
    const a = candidate({ id: 501, norm_primary: 'pote', album_title: 'Ahora Mas' });
    const b = candidate({ id: 502, norm_primary: 'pote', album_title: 'Ahora Mas' });
    const sub = submission({ norm_artist: 'pote', norm_album: normalizeAlbumTitle('Ahora Mas') });

    expect(decideLink(sub, [a, b], 'exact').kind).toBe('ambiguous');
    expect(decideLink(sub, [a, b], 'relaxed').kind).not.toBe('linked');
  });
});

describe('writeLink (no-overwrite guard)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  /** True when the condition tree carries an IS NULL guard on album_id.
   *  Robust to both condition shapes (donor idiom): the unit env's
   *  drizzle-orm stub emits `{ and: [{ eq }, { isNull: 'album_id' }] }`;
   *  real drizzle nests SQL objects with StringChunk ` is null` text. */
  const hasAlbumIdIsNullGuard = (node: unknown, seen = new Set<unknown>()): boolean => {
    if (!node || typeof node !== 'object' || seen.has(node)) return false;
    seen.add(node);
    const n = node as Record<string, unknown>;
    if (n.isNull === 'album_id') return true; // stub shape
    if (Array.isArray(n.value) && (n.value as unknown[]).some((v) => typeof v === 'string' && /is null/i.test(v))) {
      return true;
    }
    for (const child of [n.and, n.queryChunks]) {
      if (Array.isArray(child) && child.some((c) => hasAlbumIdIsNullGuard(c, seen))) return true;
    }
    return false;
  };

  it('UPDATEs album_id guarded by id AND album_id IS NULL so manual corrections and prior links always win', async () => {
    mockDb._chain.returning.mockResolvedValueOnce([{ id: 9 }]);
    await expect(writeLink(9, 501)).resolves.toBe(true);

    expect(mockDb._chain.set).toHaveBeenCalledWith({ album_id: 501 });
    const where = mockDb._chain.where.mock.calls[0][0];
    expect(hasAlbumIdIsNullGuard(where)).toBe(true);
  });

  it('returns false when the guard matched no row (already linked)', async () => {
    mockDb._chain.returning.mockResolvedValueOnce([]);
    await expect(writeLink(9, 501)).resolves.toBe(false);
  });
});
