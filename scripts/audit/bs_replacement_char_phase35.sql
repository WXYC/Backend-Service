-- V_BS_FFFD_P35: Phase 3.5 lossy-recovery U+FFFD mojibake migration for #863.
--
-- Hand-curated follow-up to scripts/audit/bs_replacement_char_recovery.sql
-- (Phase 2). That migration applied 34 UPDATEs and left 53 rows of
-- U+FFFD-corrupted text in prod — the cases auto-recovery couldn't
-- handle. The music director hand-curated audit/bs_replacement_char
-- _phase35.csv: 5+1 (after the Midnight Zone mirror) rows got canonical
-- replacements, 25 stay readable U+FFFD because no canonical was
-- identifiable.
--
-- 6 UPDATE statements follow.
--
-- Pattern is identical to Phase 2: BEGIN; SET LOCAL statement_timeout;
-- UPDATEs; COMMIT; then post-amble verifies that every targeted
-- (table, column, current) tuple shows 0 residual rows.
--
-- All proposed_top1 values are NFC-normalised and zero-width-char
-- stripped (U+200B/200C/200D/FEFF) before write.
--
-- Not round-trippable: same posture as Phase 2 / V015 / V016.

-- ===========================================================
-- Pre-amble: targeted rows + their BEFORE counts.
-- ===========================================================
SELECT '=== V_BS_FFFD_P35 pre-amble ===' AS section;
SELECT 'flowsheet' AS tbl, 'album_title' AS col, 'Midnight Zone (Original Soundtrack to the Film by Julian Charri�re)' AS lossy, (SELECT COUNT(*) FROM wxyc_schema.flowsheet WHERE album_title = 'Midnight Zone (Original Soundtrack to the Film by Julian Charri�re)') AS rows
UNION ALL
SELECT 'flowsheet' AS tbl, 'artist_name' AS col, 'Ana Mar�a Vahos' AS lossy, (SELECT COUNT(*) FROM wxyc_schema.flowsheet WHERE artist_name = 'Ana Mar�a Vahos') AS rows
UNION ALL
SELECT 'flowsheet' AS tbl, 'artist_name' AS col, 'Mehmet G�reli' AS lossy, (SELECT COUNT(*) FROM wxyc_schema.flowsheet WHERE artist_name = 'Mehmet G�reli') AS rows
UNION ALL
SELECT 'flowsheet' AS tbl, 'artist_name' AS col, 'U?ur Y�cel' AS lossy, (SELECT COUNT(*) FROM wxyc_schema.flowsheet WHERE artist_name = 'U?ur Y�cel') AS rows
UNION ALL
SELECT 'rotation' AS tbl, 'album_title' AS col, 'Midnight Zone (Original Soundtrack to the Film by Julian Charri�re)' AS lossy, (SELECT COUNT(*) FROM wxyc_schema.rotation WHERE album_title = 'Midnight Zone (Original Soundtrack to the Film by Julian Charri�re)') AS rows
UNION ALL
SELECT 'rotation' AS tbl, 'record_label' AS col, 'GER�USCHMANUFAKTUR' AS lossy, (SELECT COUNT(*) FROM wxyc_schema.rotation WHERE record_label = 'GER�USCHMANUFAKTUR') AS rows;

-- ===========================================================
-- Transactional UPDATE block.
-- ===========================================================
BEGIN;
SET LOCAL statement_timeout = '60s';

UPDATE wxyc_schema.flowsheet SET album_title = 'Midnight Zone (Original Soundtrack To The Film By Julian Charrière)' WHERE album_title = 'Midnight Zone (Original Soundtrack to the Film by Julian Charri�re)';
UPDATE wxyc_schema.flowsheet SET artist_name = 'Ana María Vahos' WHERE artist_name = 'Ana Mar�a Vahos';
UPDATE wxyc_schema.flowsheet SET artist_name = 'Mehmet Güreli' WHERE artist_name = 'Mehmet G�reli';
UPDATE wxyc_schema.flowsheet SET artist_name = 'Uğur Yücel' WHERE artist_name = 'U?ur Y�cel';
UPDATE wxyc_schema.rotation SET album_title = 'Midnight Zone (Original Soundtrack To The Film By Julian Charrière)' WHERE album_title = 'Midnight Zone (Original Soundtrack to the Film by Julian Charri�re)';
UPDATE wxyc_schema.rotation SET record_label = 'Geräuschmanufaktur' WHERE record_label = 'GER�USCHMANUFAKTUR';

COMMIT;

-- ===========================================================
-- Post-amble verify: every targeted tuple should show residual=0.
-- ===========================================================
SELECT '=== V_BS_FFFD_P35 post-amble (expect 0 for every row) ===' AS section;
SELECT 'flowsheet' AS tbl, 'album_title' AS col, 'Midnight Zone (Original Soundtrack to the Film by Julian Charri�re)' AS lossy, (SELECT COUNT(*) FROM wxyc_schema.flowsheet WHERE album_title = 'Midnight Zone (Original Soundtrack to the Film by Julian Charri�re)') AS residual
UNION ALL
SELECT 'flowsheet' AS tbl, 'artist_name' AS col, 'Ana Mar�a Vahos' AS lossy, (SELECT COUNT(*) FROM wxyc_schema.flowsheet WHERE artist_name = 'Ana Mar�a Vahos') AS residual
UNION ALL
SELECT 'flowsheet' AS tbl, 'artist_name' AS col, 'Mehmet G�reli' AS lossy, (SELECT COUNT(*) FROM wxyc_schema.flowsheet WHERE artist_name = 'Mehmet G�reli') AS residual
UNION ALL
SELECT 'flowsheet' AS tbl, 'artist_name' AS col, 'U?ur Y�cel' AS lossy, (SELECT COUNT(*) FROM wxyc_schema.flowsheet WHERE artist_name = 'U?ur Y�cel') AS residual
UNION ALL
SELECT 'rotation' AS tbl, 'album_title' AS col, 'Midnight Zone (Original Soundtrack to the Film by Julian Charri�re)' AS lossy, (SELECT COUNT(*) FROM wxyc_schema.rotation WHERE album_title = 'Midnight Zone (Original Soundtrack to the Film by Julian Charri�re)') AS residual
UNION ALL
SELECT 'rotation' AS tbl, 'record_label' AS col, 'GER�USCHMANUFAKTUR' AS lossy, (SELECT COUNT(*) FROM wxyc_schema.rotation WHERE record_label = 'GER�USCHMANUFAKTUR') AS residual
ORDER BY residual DESC, tbl, col;

-- Overall residual: should drop by exactly the sum of row_counts
-- the migration touched. The 25 still-unrecoverable rows remain.
SELECT 'AFTER — overall residual U+FFFD' AS section;
SELECT 'rotation' AS tbl, 'artist_name' AS col, (SELECT COUNT(*) FROM wxyc_schema.rotation WHERE artist_name LIKE E'%\uFFFD%') AS remaining
UNION ALL
SELECT 'rotation' AS tbl, 'album_title' AS col, (SELECT COUNT(*) FROM wxyc_schema.rotation WHERE album_title LIKE E'%\uFFFD%') AS remaining
UNION ALL
SELECT 'rotation' AS tbl, 'record_label' AS col, (SELECT COUNT(*) FROM wxyc_schema.rotation WHERE record_label LIKE E'%\uFFFD%') AS remaining
UNION ALL
SELECT 'library' AS tbl, 'artist_name' AS col, (SELECT COUNT(*) FROM wxyc_schema.library WHERE artist_name LIKE E'%\uFFFD%') AS remaining
UNION ALL
SELECT 'library' AS tbl, 'album_title' AS col, (SELECT COUNT(*) FROM wxyc_schema.library WHERE album_title LIKE E'%\uFFFD%') AS remaining
UNION ALL
SELECT 'library' AS tbl, 'label' AS col, (SELECT COUNT(*) FROM wxyc_schema.library WHERE label LIKE E'%\uFFFD%') AS remaining
UNION ALL
SELECT 'flowsheet' AS tbl, 'artist_name' AS col, (SELECT COUNT(*) FROM wxyc_schema.flowsheet WHERE artist_name LIKE E'%\uFFFD%') AS remaining
UNION ALL
SELECT 'flowsheet' AS tbl, 'track_title' AS col, (SELECT COUNT(*) FROM wxyc_schema.flowsheet WHERE track_title LIKE E'%\uFFFD%') AS remaining
UNION ALL
SELECT 'flowsheet' AS tbl, 'album_title' AS col, (SELECT COUNT(*) FROM wxyc_schema.flowsheet WHERE album_title LIKE E'%\uFFFD%') AS remaining
UNION ALL
SELECT 'flowsheet' AS tbl, 'record_label' AS col, (SELECT COUNT(*) FROM wxyc_schema.flowsheet WHERE record_label LIKE E'%\uFFFD%') AS remaining
ORDER BY remaining DESC;
