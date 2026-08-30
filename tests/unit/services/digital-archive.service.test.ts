/**
 * Unit tests for the digital-archive playback manifest builder (BS#2320).
 *
 * `db.execute` is mocked to hand back canned file rows (the JOIN's shape,
 * `digital-archive.service.ts`'s `PlaybackFileRow`) — this file pins the
 * JS-side grouping/ordering/merge logic, not the SQL text. `presignGet` is
 * mocked so no real S3-compatible call happens.
 */
import { jest } from '@jest/globals';
import { db } from '../../mocks/database.mock';

const mockPresignGet = jest.fn<(storeName: string, key: string, ttl: number) => Promise<string>>();
jest.mock('../../../apps/backend/services/digital-archive-store.service', () => ({
  presignGet: mockPresignGet,
}));

import { getConfig, resetConfig } from '../../../apps/backend/config/digitalArchive';
import { getPlaybackManifest } from '../../../apps/backend/services/digital-archive.service';

type Row = {
  file_id: number;
  asset_id: number;
  provenance: string;
  disc_number: number;
  track_number: number | null;
  title: string;
  duration_secs: number | null;
  md5: string | null;
  codec: string;
  bitrate_kbps: number | null;
  object_key: string;
  store_name: string;
};

const row = (overrides: Partial<Row> & Pick<Row, 'file_id' | 'asset_id' | 'title'>): Row => ({
  provenance: 'rotation_upload',
  disc_number: 1,
  track_number: null,
  duration_secs: null,
  md5: null,
  codec: 'mp3',
  bitrate_kbps: null,
  object_key: `key-${overrides.file_id}`,
  store_name: 'azuracast',
  ...overrides,
});

describe('digital-archive.service getPlaybackManifest', () => {
  beforeEach(() => {
    db.execute.mockReset();
    mockPresignGet
      .mockReset()
      .mockImplementation((storeName, key) => Promise.resolve(`https://example.com/${storeName}/${key}`));
    delete process.env.DIGITAL_ARCHIVE_SIGN_TTL_SECONDS;
    resetConfig();
  });

  it('returns null when there are no bound-asset file rows (no bound asset, or a bound asset with no files)', async () => {
    db.execute.mockResolvedValueOnce([]);
    const manifest = await getPlaybackManifest(42);
    expect(manifest).toBeNull();
  });

  it('builds a single-track manifest with one rendition', async () => {
    db.execute.mockResolvedValueOnce([
      row({ file_id: 1, asset_id: 10, title: 'Side A', track_number: 1, md5: 'abc123', duration_secs: 180 }),
    ]);
    const manifest = await getPlaybackManifest(42);
    expect(manifest).not.toBeNull();
    expect(manifest!.library_id).toBe(42);
    expect(manifest!.tracks).toHaveLength(1);
    expect(manifest!.tracks[0]).toEqual({
      file_id: 1,
      provenance: 'rotation_upload',
      disc_number: 1,
      track_number: 1,
      title: 'Side A',
      duration_secs: 180,
      content_hash: 'abc123',
      renditions: [{ codec: 'mp3', bitrate_kbps: null, url: 'https://example.com/azuracast/key-1' }],
    });
  });

  it('sets expires_at TTL seconds in the future using the configured TTL', async () => {
    process.env.DIGITAL_ARCHIVE_SIGN_TTL_SECONDS = '60';
    resetConfig();
    db.execute.mockResolvedValueOnce([row({ file_id: 1, asset_id: 10, title: 'T' })]);
    const before = Date.now();
    const manifest = await getPlaybackManifest(1);
    const expiresAtMs = new Date(manifest!.expires_at).getTime();
    expect(expiresAtMs).toBeGreaterThanOrEqual(before + 60_000 - 1000);
    expect(expiresAtMs).toBeLessThanOrEqual(Date.now() + 60_000 + 1000);
    expect(getConfig().signTTLSeconds).toBe(60);
  });

  it('merges several bound assets for one album (multi-disc), no precedence rule', async () => {
    db.execute.mockResolvedValueOnce([
      row({ file_id: 1, asset_id: 10, disc_number: 1, track_number: 1, title: 'Disc 1 Track 1' }),
      row({ file_id: 2, asset_id: 11, disc_number: 2, track_number: 1, title: 'Disc 2 Track 1' }),
    ]);
    const manifest = await getPlaybackManifest(1);
    expect(manifest!.tracks.map((t) => [t.disc_number, t.track_number, t.title])).toEqual([
      [1, 1, 'Disc 1 Track 1'],
      [2, 1, 'Disc 2 Track 1'],
    ]);
  });

  it('projects per-track provenance from its own parent asset when assets differ in provenance', async () => {
    db.execute.mockResolvedValueOnce([
      row({ file_id: 1, asset_id: 10, provenance: 'rotation_upload', disc_number: 1, track_number: 1, title: 'A' }),
      row({ file_id: 2, asset_id: 12, provenance: 'cd_rip', disc_number: 1, track_number: 1, title: 'B' }),
    ]);
    const manifest = await getPlaybackManifest(1);
    const provenanceByTitle = new Map(manifest!.tracks.map((t) => [t.title, t.provenance]));
    expect(provenanceByTitle.get('A')).toBe('rotation_upload');
    expect(provenanceByTitle.get('B')).toBe('cd_rip');
  });

  it('groups multiple files for the same (asset, track_number, title) into one track with several renditions', async () => {
    db.execute.mockResolvedValueOnce([
      row({ file_id: 1, asset_id: 10, track_number: 1, title: 'Same Track', codec: 'mp3', md5: 'primary-md5' }),
      row({ file_id: 2, asset_id: 10, track_number: 1, title: 'Same Track', codec: 'flac', md5: 'secondary-md5' }),
    ]);
    const manifest = await getPlaybackManifest(1);
    expect(manifest!.tracks).toHaveLength(1);
    const track = manifest!.tracks[0];
    // Canonical track-level fields come from the lowest-id file (the SQL's
    // id ASC tiebreak), not the second rendition.
    expect(track.file_id).toBe(1);
    expect(track.content_hash).toBe('primary-md5');
    expect(track.renditions).toEqual([
      { codec: 'mp3', bitrate_kbps: null, url: 'https://example.com/azuracast/key-1' },
      { codec: 'flac', bitrate_kbps: null, url: 'https://example.com/azuracast/key-2' },
    ]);
  });

  it('serves every codec, not just mp3', async () => {
    db.execute.mockResolvedValueOnce([
      row({ file_id: 1, asset_id: 10, track_number: 1, title: 'Lossless', codec: 'flac' }),
    ]);
    const manifest = await getPlaybackManifest(1);
    expect(manifest!.tracks[0].renditions[0].codec).toBe('flac');
  });

  it('preserves the SQL-provided ordering (disc_number, track_number NULLS LAST, title) rather than re-sorting', async () => {
    // The service trusts the query's ORDER BY; a null track_number row
    // arrives already placed last by the SQL, and grouping must not
    // reorder it back to the front.
    db.execute.mockResolvedValueOnce([
      row({ file_id: 1, asset_id: 10, disc_number: 1, track_number: 1, title: 'First' }),
      row({ file_id: 2, asset_id: 11, disc_number: 1, track_number: 2, title: 'Second' }),
      row({ file_id: 3, asset_id: 12, disc_number: 1, track_number: null, title: 'Untagged Bonus Track' }),
    ]);
    const manifest = await getPlaybackManifest(1);
    expect(manifest!.tracks.map((t) => t.title)).toEqual(['First', 'Second', 'Untagged Bonus Track']);
    expect(manifest!.tracks[2].track_number).toBeNull();
  });
});
