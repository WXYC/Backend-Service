import { exportReviewCsv, importReviewCsv, type ReviewRow } from '../../../../jobs/digital-archive-bind/csv';

const row = (overrides: Partial<ReviewRow> & { assetId: number }): ReviewRow => ({
  libraryId: 100,
  discNumber: 1,
  provenance: 'rotation_upload',
  bindNote: 'exact',
  contentKind: 'freeform',
  proposedArtist: 'Jessica Pratt',
  proposedAlbumTitle: 'On Your Own Love Again',
  tagArtist: 'Jessica Pratt',
  tagAlbum: 'On Your Own Love Again',
  objectKeys: ['library/freeform/Jessica Pratt/On Your Own Love Again/01.mp3'],
  ...overrides,
});

describe('digital-archive-bind csv', () => {
  it('round-trips asset id, tags, proposed library id, bind_note, and prefix', () => {
    const rows: ReviewRow[] = [row({ assetId: 1 }), row({ assetId: 2, libraryId: 200, bindNote: 'fuzzy:relaxed-key' })];
    const csv = exportReviewCsv(rows);

    expect(csv).toContain('asset_id');
    expect(csv).toContain('library_id');
    expect(csv).toContain('proposed_artist');
    expect(csv).toContain('bind_note');
    expect(csv).toContain('decision');

    // Nobody has filled in a decision yet -- importing the untouched export flips nothing.
    expect(importReviewCsv(csv)).toEqual([]);
  });

  it('quotes a field containing a comma', () => {
    const csv = exportReviewCsv([row({ assetId: 1, proposedAlbumTitle: 'Nerve Bumps, A Queer Divine Satisfaction' })]);
    expect(csv).toContain('"Nerve Bumps, A Queer Divine Satisfaction"');
  });

  it('joins multiple object keys with a semicolon', () => {
    const csv = exportReviewCsv([row({ assetId: 1, objectKeys: ['a/01.mp3', 'a/02.mp3'] })]);
    expect(csv).toContain('a/01.mp3; a/02.mp3');
  });

  it('flips exactly the rows a reviewer marked bound or rejected', () => {
    const csv = exportReviewCsv([row({ assetId: 1 }), row({ assetId: 2 }), row({ assetId: 3 })]);
    const lines = csv.split('\n');
    const decisionIndex = lines[0].split(',').indexOf('decision');

    const decided = lines.map((line, i) => {
      if (i === 0 || line.trim() === '') return line;
      const cells = line.split(',');
      if (i === 1) cells[decisionIndex] = 'bound';
      if (i === 2) cells[decisionIndex] = 'rejected';
      return cells.join(',');
    });

    const decisions = importReviewCsv(decided.join('\n'));
    expect(decisions).toEqual(
      expect.arrayContaining([
        { assetId: 1, decision: 'bound', note: '' },
        { assetId: 2, decision: 'rejected', note: '' },
      ])
    );
    expect(decisions.find((d) => d.assetId === 3)).toBeUndefined();
  });

  it('ignores an unrecognized decision value rather than treating it as a transition', () => {
    const csv = [
      'asset_id,library_id,disc_number,provenance,content_kind,bind_note,proposed_artist,proposed_album_title,tag_artist,tag_album,object_keys,decision,note',
      '1,100,1,rotation_upload,freeform,exact,Artist,Album,Artist,Album,key.mp3,maybe,',
    ].join('\n');
    expect(importReviewCsv(csv)).toEqual([]);
  });

  it('carries a reviewer note through the round trip', () => {
    const csv = [
      'asset_id,library_id,disc_number,provenance,content_kind,bind_note,proposed_artist,proposed_album_title,tag_artist,tag_album,object_keys,decision,note',
      '1,100,1,rotation_upload,freeform,exact,Artist,Album,Artist,Album,key.mp3,rejected,"wrong pressing, keep looking"',
    ].join('\n');
    expect(importReviewCsv(csv)).toEqual([{ assetId: 1, decision: 'rejected', note: 'wrong pressing, keep looking' }]);
  });
});
