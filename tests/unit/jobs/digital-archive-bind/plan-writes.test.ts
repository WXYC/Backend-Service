import { planWrites, type ExistingSlot } from '../../../../jobs/digital-archive-bind/write';
import type { MatchedAlbum } from '../../../../jobs/digital-archive-bind/types';

const matchedOf = (
  libraryId: number,
  discNumber: number,
  objectKeys: string[],
  tier: 'exact' | 'fuzzy' = 'exact'
): MatchedAlbum => ({
  candidate: {
    contentKind: 'freeform',
    artistFoldKey: 'artist',
    albumNormKey: 'album',
    discNumber,
    displayArtist: 'Artist',
    displayAlbum: 'Album',
    files: objectKeys.map((objectKey) => ({
      objectKey,
      contentKind: 'freeform',
      codec: 'mp3',
      bytes: 1000,
      md5: null,
      tags: { title: null, artist: null, album: null, albumArtist: null, track: null, disc: null, durationMs: null },
    })),
  },
  libraryId,
  tier,
  bindNote: tier,
});

describe('digital-archive-bind planWrites', () => {
  it('plans an insert for a candidate with no existing slot', () => {
    const plan = planWrites([matchedOf(1, 1, ['a.mp3'])], [], new Map(), new Set());
    expect(plan.toInsert).toHaveLength(1);
    expect(plan.rejectedBlocked).toHaveLength(0);
    expect(plan.rejectedReopened).toHaveLength(0);
    expect(plan.boundDrift).toHaveLength(0);
  });

  it('skips a slot already needs_review -- a re-run is a no-op', () => {
    const existing: ExistingSlot[] = [{ id: 10, libraryId: 1, discNumber: 1, status: 'needs_review' }];
    const plan = planWrites([matchedOf(1, 1, ['a.mp3'])], existing, new Map(), new Set());
    expect(plan.toInsert).toHaveLength(0);
    expect(plan.rejectedBlocked).toHaveLength(0);
    expect(plan.rejectedReopened).toHaveLength(0);
    expect(plan.boundDrift).toHaveLength(0);
  });

  it('skips and reports a slot held by a rejected row, with its object keys and slot', () => {
    const existing: ExistingSlot[] = [{ id: 20, libraryId: 1, discNumber: 1, status: 'rejected' }];
    const plan = planWrites([matchedOf(1, 1, ['a.mp3', 'b.mp3'])], existing, new Map(), new Set());
    expect(plan.toInsert).toHaveLength(0);
    expect(plan.rejectedReopened).toHaveLength(0);
    expect(plan.rejectedBlocked).toEqual([{ libraryId: 1, discNumber: 1, objectKeys: ['a.mp3', 'b.mp3'] }]);
  });

  it('reopens a rejected slot when --rebind-keys names one of the candidate object keys', () => {
    const existing: ExistingSlot[] = [{ id: 20, libraryId: 1, discNumber: 1, status: 'rejected' }];
    const plan = planWrites([matchedOf(1, 1, ['a.mp3', 'b.mp3'])], existing, new Map(), new Set(['b.mp3']));
    expect(plan.rejectedBlocked).toHaveLength(0);
    expect(plan.rejectedReopened).toEqual([{ assetId: 20, matched: matchedOf(1, 1, ['a.mp3', 'b.mp3']) }]);
  });

  it('never writes into a bound slot, even under --rebind-keys', () => {
    const existing: ExistingSlot[] = [{ id: 30, libraryId: 1, discNumber: 1, status: 'bound' }];
    const boundFiles = new Map([[30, ['a.mp3']]]);
    const plan = planWrites([matchedOf(1, 1, ['a.mp3'])], existing, boundFiles, new Set(['a.mp3']));
    expect(plan.toInsert).toHaveLength(0);
    expect(plan.rejectedReopened).toHaveLength(0);
    expect(plan.boundDrift).toHaveLength(0); // keys match -- no drift
  });

  it("reports drift when a bound slot's files differ from the candidate's keys", () => {
    const existing: ExistingSlot[] = [{ id: 30, libraryId: 1, discNumber: 1, status: 'bound' }];
    const boundFiles = new Map([[30, ['old-key.mp3']]]);
    const plan = planWrites([matchedOf(1, 1, ['new-key.mp3'])], existing, boundFiles, new Set());
    expect(plan.toInsert).toHaveLength(0);
    expect(plan.boundDrift).toEqual([
      { assetId: 30, libraryId: 1, discNumber: 1, candidateKeys: ['new-key.mp3'], boundKeys: ['old-key.mp3'] },
    ]);
  });

  it('treats disc_number as part of the slot key -- disc 2 of a bound album still inserts', () => {
    const existing: ExistingSlot[] = [{ id: 30, libraryId: 1, discNumber: 1, status: 'bound' }];
    const boundFiles = new Map([[30, ['disc1.mp3']]]);
    const plan = planWrites([matchedOf(1, 2, ['disc2.mp3'])], existing, boundFiles, new Set());
    expect(plan.toInsert).toHaveLength(1);
    expect(plan.boundDrift).toHaveLength(0);
  });

  it('reports a same-run collision when two candidates target the same empty slot, and queues only the first', () => {
    // e.g. a freeform/ copy and a rotation/Heavy/ copy of the same album,
    // both present in the Space and both matching the same library_id.
    const plan = planWrites(
      [matchedOf(1, 1, ['freeform.mp3']), matchedOf(1, 1, ['rotation.mp3'])],
      [],
      new Map(),
      new Set()
    );
    expect(plan.toInsert).toHaveLength(1);
    expect(plan.toInsert[0].candidate.files[0].objectKey).toBe('freeform.mp3');
    expect(plan.sameRunCollision).toEqual([{ libraryId: 1, discNumber: 1, objectKeys: ['rotation.mp3'] }]);
  });
});
