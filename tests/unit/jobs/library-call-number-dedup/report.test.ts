/**
 * Unit tests for library-call-number-dedup's report.ts.
 *
 * The worklist is the only part of this job a person acts on, and it is acted
 * on away from the screen, at the shelf. So the assertions here are about
 * legibility under that constraint: both call numbers appear in full, the disc
 * that moves is never confused with the one that stays, and a withheld slot
 * says why it was withheld rather than silently vanishing from the list.
 *
 * The second block covers the other half of legibility: whether the document
 * admits it is a preview. A dry-run worklist describes shelf work against a
 * catalog that has not moved, so the assertions there are about the warning
 * surviving the ways a markdown table actually travels — forwarded, pasted
 * without its opening paragraph, or printed.
 */
import { formatWorklist, type HeldItem, type RelabelItem } from '../../../../jobs/library-call-number-dedup/report';

const item = (over: Partial<RelabelItem> = {}): RelabelItem => ({
  genre: 'Rock',
  artist: 'Guided by Voices',
  codeLetters: 'GU',
  artistGenreCode: 12,
  moveTitle: 'Bee Thousand',
  keepTitle: 'Alien Lanes',
  oldNumber: 6,
  newNumber: 31,
  vol: '',
  ...over,
});

describe('formatWorklist', () => {
  it('renders both call numbers so the shelf work is unambiguous', () => {
    const out = formatWorklist([item()], [], 'execute');
    expect(out).toContain('`GU 12 6`');
    expect(out).toContain('`GU 12 31`');
  });

  it('names the disc that moves and the one that stays', () => {
    const out = formatWorklist([item()], [], 'execute');
    const row = out.split('\n').find((l) => l.includes('Bee Thousand'));
    expect(row).toBeDefined();
    expect(row.indexOf('Bee Thousand')).toBeLessThan(row.indexOf('Alien Lanes'));
  });

  it('includes the volume letter when the slot has one', () => {
    const out = formatWorklist([item({ vol: 'B', oldNumber: 3, newNumber: 12 })], [], 'execute');
    expect(out).toContain('`GU 12 3 B`');
    expect(out).toContain('`GU 12 12 B`');
  });

  it('counts the discs and genres in the header', () => {
    const out = formatWorklist([item(), item({ genre: 'Jazz', artist: 'Jo Jones', codeLetters: 'JO' })], [], 'execute');
    expect(out).toContain('**2 discs to relabel**');
    expect(out).toContain('across 2 genres');
  });

  it('groups by genre and sorts within a shelf by number', () => {
    const out = formatWorklist(
      [item({ oldNumber: 9, moveTitle: 'Later' }), item({ oldNumber: 2, moveTitle: 'Earlier' })],
      [],
      'execute'
    );
    expect(out.indexOf('Earlier')).toBeLessThan(out.indexOf('Later'));
  });

  it('lists withheld slots with the reason, in their own section', () => {
    const held: HeldItem[] = [
      {
        genre: 'Africa',
        artist: 'King Sunny Ade',
        codeLetters: 'AD',
        artistGenreCode: 4,
        title: 'Juju Music',
        atNumber: 1,
        vol: '',
        reason: 'already sits at another number on this shelf',
      },
    ];
    const out = formatWorklist([item()], held, 'execute');
    expect(out).toContain('## Needs your judgement');
    expect(out).toContain('Juju Music');
    expect(out).toContain('already sits at another number');
    expect(out).toContain('**1 that need your judgement**');
  });

  it('renders a held item on a lettered shelf at its real address', () => {
    const out = formatWorklist(
      [],
      [
        {
          genre: 'Rock',
          artist: 'Guided by Voices',
          codeLetters: 'GU',
          artistGenreCode: 12,
          title: 'Bee Thousand',
          atNumber: 3,
          vol: 'B',
          reason: 'twin elsewhere',
        },
      ],
      'execute'
    );
    // `GU 12 3` and `GU 12 3 B` are different physical slots; sending the
    // librarian to the unlettered one points at the wrong disc.
    expect(out).toContain('`GU 12 3 B`');
  });

  it('drops the artist number cleanly when the shelf has none', () => {
    const out = formatWorklist([item({ artistGenreCode: null })], [], 'execute');
    expect(out).toContain('`GU 6`');
    expect(out).toContain('`GU 31`');
  });

  it('omits the judgement section entirely when nothing was withheld', () => {
    expect(formatWorklist([item()], [], 'execute')).not.toContain('## Needs your judgement');
  });

  it('renders a clean run without crashing or claiming work', () => {
    const out = formatWorklist([], [], 'execute');
    expect(out).toContain('**0 discs to relabel**');
    expect(out).not.toContain('## Needs your judgement');
  });

  it('gives the executed worklist a clean title and no preview marking anywhere', () => {
    const out = formatWorklist([item()], [], 'execute');
    expect(out.split('\n')[0]).toBe('# Call-number relabel worklist');
    expect(out).not.toMatch(/PREVIEW|DO NOT/);
  });
});

describe('formatWorklist, dry run', () => {
  const held: HeldItem[] = [
    {
      genre: 'Africa',
      artist: 'King Sunny Ade',
      codeLetters: 'AD',
      artistGenreCode: 4,
      title: 'Juju Music',
      atNumber: 1,
      vol: '',
      reason: 'already sits at another number on this shelf',
    },
  ];

  it('puts the warning in the title, which is what a paste or a print header inherits', () => {
    const out = formatWorklist([item()], [], 'dry-run');
    expect(out.split('\n')[0]).toBe('# Call-number relabel worklist — PREVIEW, DO NOT DISTRIBUTE');
  });

  it('warns above the table and again below it, so a forwarded tail still carries it', () => {
    const out = formatWorklist([item()], held, 'dry-run');
    const table = out.indexOf('| PREVIEW |');
    expect(out.slice(0, table)).toContain('DO NOT SEND THIS TO THE LIBRARIAN');
    expect(out.slice(table)).toContain('End of PREVIEW');
  });

  it('keeps the footer after the judgement section rather than stranding it mid-document', () => {
    const out = formatWorklist([item()], held, 'dry-run');
    expect(out.indexOf('## Needs your judgement')).toBeLessThan(out.indexOf('End of PREVIEW'));
  });

  it('marks every row, so a single row lifted out of the table is still legible as a preview', () => {
    const out = formatWorklist([item(), item({ genre: 'Jazz', artist: 'Jo Jones', codeLetters: 'JO' })], [], 'dry-run');
    const rows = out.split('\n').filter((l) => l.includes('Bee Thousand'));
    expect(rows).toHaveLength(2);
    for (const row of rows) expect(row.startsWith('| PREVIEW |')).toBe(true);
    expect(out).not.toContain('| ☐ |');
  });

  it('states the numbers as planned rather than as assigned', () => {
    const out = formatWorklist([item()], held, 'dry-run');
    expect(out).toContain('Would become');
    expect(out).toContain('**1 disc would need relabelling**');
    expect(out).toContain('**1 that would need your judgement**');
    expect(out).not.toContain('to relabel**');
  });

  it('gives no relabelling instruction, since there is nothing to act on yet', () => {
    const out = formatWorklist([item()], [], 'dry-run');
    expect(out).not.toContain('cross out its number');
    expect(out).toContain('Nothing here is an instruction');
  });

  it('still shows the same rows and numbers, so the plan can be reviewed before approval', () => {
    const out = formatWorklist([item()], [], 'dry-run');
    expect(out).toContain('`GU 12 6`');
    expect(out).toContain('`GU 12 31`');
    expect(out).toContain('Bee Thousand');
  });

  it('warns even on an empty plan, which is the run most likely to be mistaken for the real one', () => {
    const out = formatWorklist([], [], 'dry-run');
    expect(out).toContain('PREVIEW, DO NOT DISTRIBUTE');
    expect(out).toContain('End of PREVIEW');
  });
});
