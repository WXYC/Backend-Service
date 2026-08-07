/**
 * Unit tests for library-call-number-dedup's report.ts.
 *
 * The worklist is the only part of this job a person acts on, and it is acted
 * on away from the screen, at the shelf. So the assertions here are about
 * legibility under that constraint: both call numbers appear in full, the disc
 * that moves is never confused with the one that stays, and a withheld slot
 * says why it was withheld rather than silently vanishing from the list.
 */
import { formatWorklist, type HeldItem, type RelabelItem } from '../../../../jobs/library-call-number-dedup/report';

const item = (over: Partial<RelabelItem> = {}): RelabelItem => ({
  genre: 'Rock',
  artist: 'Guided by Voices',
  codeLetters: 'GU',
  moveTitle: 'Bee Thousand',
  keepTitle: 'Alien Lanes',
  oldNumber: 6,
  newNumber: 31,
  vol: '',
  ...over,
});

describe('formatWorklist', () => {
  it('renders both call numbers so the shelf work is unambiguous', () => {
    const out = formatWorklist([item()], []);
    expect(out).toContain('`GU 6`');
    expect(out).toContain('`GU 31`');
  });

  it('names the disc that moves and the one that stays', () => {
    const out = formatWorklist([item()], []);
    const row = out.split('\n').find((l) => l.includes('Bee Thousand'));
    expect(row).toBeDefined();
    expect(row.indexOf('Bee Thousand')).toBeLessThan(row.indexOf('Alien Lanes'));
  });

  it('includes the volume letter when the slot has one', () => {
    const out = formatWorklist([item({ vol: 'B', oldNumber: 3, newNumber: 12 })], []);
    expect(out).toContain('`GU 3 B`');
    expect(out).toContain('`GU 12 B`');
  });

  it('counts the discs and genres in the header', () => {
    const out = formatWorklist([item(), item({ genre: 'Jazz', artist: 'Jo Jones', codeLetters: 'JO' })], []);
    expect(out).toContain('**2 discs to relabel**');
    expect(out).toContain('across 2 genres');
  });

  it('groups by genre and sorts within a shelf by number', () => {
    const out = formatWorklist(
      [item({ oldNumber: 9, moveTitle: 'Later' }), item({ oldNumber: 2, moveTitle: 'Earlier' })],
      []
    );
    expect(out.indexOf('Earlier')).toBeLessThan(out.indexOf('Later'));
  });

  it('lists withheld slots with the reason, in their own section', () => {
    const held: HeldItem[] = [
      {
        genre: 'Africa',
        artist: 'King Sunny Ade',
        codeLetters: 'AD',
        title: 'Juju Music',
        atNumber: 1,
        reason: 'already sits at another number on this shelf',
      },
    ];
    const out = formatWorklist([item()], held);
    expect(out).toContain('## Needs your judgement');
    expect(out).toContain('Juju Music');
    expect(out).toContain('already sits at another number');
    expect(out).toContain('**1 that need your judgement**');
  });

  it('omits the judgement section entirely when nothing was withheld', () => {
    expect(formatWorklist([item()], [])).not.toContain('## Needs your judgement');
  });

  it('renders a clean run without crashing or claiming work', () => {
    const out = formatWorklist([], []);
    expect(out).toContain('**0 discs to relabel**');
    expect(out).not.toContain('## Needs your judgement');
  });
});
