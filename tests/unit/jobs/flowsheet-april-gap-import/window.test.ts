/**
 * Unit tests for jobs/flowsheet-april-gap-import/window.ts.
 *
 * The default window is the BS#351 residue: 2026-04-16 -> 2026-04-20 Eastern
 * wall clock (399 rows / 15 shows). The 4 August rows are deliberately out
 * of the default scope — see the BS#2119 scope decision in the job README —
 * so an operator must explicitly widen GAP_IMPORT_WINDOW_START/END to reach
 * them.
 */
import {
  resolveWindow,
  DEFAULT_WINDOW_START,
  DEFAULT_WINDOW_END,
} from '../../../../jobs/flowsheet-april-gap-import/window';

describe('resolveWindow', () => {
  it('defaults to the April 2026-04-16 -> 2026-04-21 (exclusive) window when unset', () => {
    const window = resolveWindow(undefined, undefined);

    // 2026-04-16 00:00:00 ET is EDT (-04:00) -> 2026-04-16T04:00:00.000Z
    expect(new Date(window.startMs).toISOString()).toBe('2026-04-16T04:00:00.000Z');
    // 2026-04-21 00:00:00 ET (exclusive upper bound, covers through end of 4/20)
    expect(new Date(window.endMs).toISOString()).toBe('2026-04-21T04:00:00.000Z');
  });

  it('treats an empty string the same as unset', () => {
    const window = resolveWindow('', '');
    expect(new Date(window.startMs).toISOString()).toBe('2026-04-16T04:00:00.000Z');
  });

  it('honors an explicit override (e.g. widening to include the August rows)', () => {
    const window = resolveWindow('2026-08-09 00:00:00', '2026-08-12 00:00:00');

    expect(new Date(window.startMs).toISOString()).toBe('2026-08-09T04:00:00.000Z');
    expect(new Date(window.endMs).toISOString()).toBe('2026-08-12T04:00:00.000Z');
  });

  it('throws for an unparseable GAP_IMPORT_WINDOW_START', () => {
    expect(() => resolveWindow('not-a-date', undefined)).toThrow(/GAP_IMPORT_WINDOW_START/);
  });

  it('throws for an unparseable GAP_IMPORT_WINDOW_END', () => {
    expect(() => resolveWindow(undefined, 'not-a-date')).toThrow(/GAP_IMPORT_WINDOW_END/);
  });

  it('throws when the end is not after the start', () => {
    expect(() => resolveWindow('2026-04-20 00:00:00', '2026-04-16 00:00:00')).toThrow(
      /must be after GAP_IMPORT_WINDOW_START/
    );
  });

  it('throws when the end equals the start', () => {
    expect(() => resolveWindow('2026-04-16 00:00:00', '2026-04-16 00:00:00')).toThrow(
      /must be after GAP_IMPORT_WINDOW_START/
    );
  });

  it('exposes the raw default strings for the README / --help text to stay in sync', () => {
    expect(DEFAULT_WINDOW_START).toBe('2026-04-16 00:00:00');
    expect(DEFAULT_WINDOW_END).toBe('2026-04-21 00:00:00');
  });
});
