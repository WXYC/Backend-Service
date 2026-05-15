-- V_BS_FFFD: Lossy-recovery U+FFFD mojibake migration for #863.
--
-- The `V_BS_FFFD` prefix mirrors tubafrenzy's V015/V016 naming, but this is
-- a HAND-APPLIED script, NOT a Drizzle/Flyway-tracked migration — there is
-- no entry in shared/database/src/migrations/ and the version-control burden
-- is just `git log -- scripts/audit/bs_replacement_char_recovery.sql`. The
-- operator runs it via `psql -f` against prod RDS using the EC2-docker
-- pattern in scripts/query-flowsheet.sh.
--
-- Phase 1 audit at scripts/audit/bs_replacement_char_audit.csv
-- enumerated 65 distinct lossy values across 113 rows in three
-- tables (rotation, library, flowsheet). Phase 2 proposals at
-- audit/bs_replacement_char_proposals.csv were generated via the
-- tubafrenzy V015/V016 matcher (LML-fuzzy) extended with two
-- Discogs search passes (longest-anchor + per-anchor) and a
-- MusicBrainz fallback for ARTIST_NAME rows; the resulting CSV
-- was hand-curated by the music director.
--
-- 34 UPDATE statements follow. Four rows were dropped
-- during curation because no canonical was recoverable.
--
-- Six of the 34 rows are CURATOR-EDITED canonicals (auto-pass returned
-- empty proposed_top1; the music director filled in the canonical by
-- hand). The generator's inclusion rule treats these as approved-for-
-- migration because their proposed_top1 differs from the auto-pass
-- output captured in git history (commit d1cb225 pre-curation snapshot).
-- The curator-edited tuples are:
--
--   flowsheet.album_title  L'�?il écoute / Dedans-Dehors          → L'Œil Écoute / Dedans-Dehors
--   flowsheet.track_title  Mallku Diabl�n                          → Mallku Diablón
--   flowsheet.track_title  Bliws Afon T�f                          → Bliws Afon Tâf
--   flowsheet.track_title  Ch'uwancha�a ~El Golpe Final~          → Ch'uwanchaña ~El Golpe Final~
--   flowsheet.track_title  Convocaci�n "Banger/Diffusion"          → Convocación "Banger/Diffusion"
--   rotation.artist_name   }�{ (Louise Boghossian and Romain Vasset) → }Ï{ (Louise Boghossian and Romain Vasset)
--
-- Pattern: BEGIN; UPDATEs; COMMIT; then the post-amble verifies
-- that no targeted (table, column, current) tuple still matches
-- after the run (expected count: 0 for every row). The pre-amble is
-- a SPOT-CHECK (top-10 by row_count, eyeball before COMMIT); the
-- post-amble is EXHAUSTIVE across all 34 targeted tuples.
--
-- NOT round-trippable: the original characters were already lost
-- upstream when U+FFFD was written into the data. This migration
-- injects plausible canonical strings over those bytes per the
-- review process — same posture as tubafrenzy V015/V016.
--
-- NFC-normalised and zero-width-char-stripped (U+200B/200C/200D/FEFF)
-- before write to defend Lucene / trgm tokenization downstream.
--
-- Idempotency: a successful run leaves zero matching rows for every
-- targeted lossy. Re-running this script after success is a no-op,
-- but the pre-amble's BEFORE counts will all be zero — that's expected
-- on re-runs, not a regression.

-- ===========================================================
-- Pre-amble audit: rows targeted by this run, by source group.
-- ===========================================================
SELECT '=== V_BS_FFFD pre-amble: rows targeted per (table, column) ===' AS section;

-- flowsheet.album_title: 8 lossy values, 20 rows total
-- flowsheet.artist_name: 3 lossy values, 5 rows total
-- flowsheet.record_label: 1 lossy value, 8 rows total
-- flowsheet.track_title: 5 lossy values, 7 rows total
-- library.album_title: 7 lossy values, 7 rows total
-- library.artist_name: 2 lossy values, 5 rows total
-- rotation.album_title: 2 lossy values, 2 rows total
-- rotation.artist_name: 5 lossy values, 5 rows total
-- rotation.record_label: 1 lossy value, 1 row total

-- Spot-check the worst offenders to confirm the migration is
-- about to touch real rows. Eyeball before COMMIT.
SELECT 'BEFORE — top 10 by row_count' AS section;
SELECT 'flowsheet' AS tbl, 'album_title' AS col, 'A Sua Divers�o / N�o Tem Nada N�o' AS lossy, (SELECT COUNT(*) FROM wxyc_schema.flowsheet WHERE album_title = 'A Sua Divers�o / N�o Tem Nada N�o') AS rows
UNION ALL
SELECT 'flowsheet' AS tbl, 'record_label' AS col, 'Infin� Editions' AS lossy, (SELECT COUNT(*) FROM wxyc_schema.flowsheet WHERE record_label = 'Infin� Editions') AS rows
UNION ALL
SELECT 'flowsheet' AS tbl, 'album_title' AS col, 'Music from the Caucasus � The Archive of ORED Recordings, 2013�2023' AS lossy, (SELECT COUNT(*) FROM wxyc_schema.flowsheet WHERE album_title = 'Music from the Caucasus � The Archive of ORED Recordings, 2013�2023') AS rows
UNION ALL
SELECT 'library' AS tbl, 'artist_name' AS col, 'Beyonc�' AS lossy, (SELECT COUNT(*) FROM wxyc_schema.library WHERE artist_name = 'Beyonc�') AS rows
UNION ALL
SELECT 'flowsheet' AS tbl, 'track_title' AS col, 'Mallku Diabl�n' AS lossy, (SELECT COUNT(*) FROM wxyc_schema.flowsheet WHERE track_title = 'Mallku Diabl�n') AS rows
UNION ALL
SELECT 'flowsheet' AS tbl, 'album_title' AS col, 'Rem�nytelen' AS lossy, (SELECT COUNT(*) FROM wxyc_schema.flowsheet WHERE album_title = 'Rem�nytelen') AS rows
UNION ALL
SELECT 'flowsheet' AS tbl, 'artist_name' AS col, 'Csillagrabl�k' AS lossy, (SELECT COUNT(*) FROM wxyc_schema.flowsheet WHERE artist_name = 'Csillagrabl�k') AS rows
UNION ALL
SELECT 'flowsheet' AS tbl, 'artist_name' AS col, 'Sonido Due�ez' AS lossy, (SELECT COUNT(*) FROM wxyc_schema.flowsheet WHERE artist_name = 'Sonido Due�ez') AS rows
UNION ALL
SELECT 'flowsheet' AS tbl, 'album_title' AS col, 'Ach Golgatha / Pour Que Les Fruits Mûrissent Cet �té' AS lossy, (SELECT COUNT(*) FROM wxyc_schema.flowsheet WHERE album_title = 'Ach Golgatha / Pour Que Les Fruits Mûrissent Cet �té') AS rows
UNION ALL
SELECT 'flowsheet' AS tbl, 'album_title' AS col, 'Ahora M�s Que Nunca' AS lossy, (SELECT COUNT(*) FROM wxyc_schema.flowsheet WHERE album_title = 'Ahora M�s Que Nunca') AS rows;

-- ===========================================================
-- Transactional UPDATE block.
-- ===========================================================
BEGIN;
SET LOCAL statement_timeout = '120s';

UPDATE wxyc_schema.flowsheet SET album_title = 'A Sua Diversão / Não Tem Nada Não' WHERE album_title = 'A Sua Divers�o / N�o Tem Nada N�o';
UPDATE wxyc_schema.flowsheet SET album_title = 'Music From The Caucasus - The Archive Of ORED Recordings 2013-23' WHERE album_title = 'Music from the Caucasus � The Archive of ORED Recordings, 2013�2023';
UPDATE wxyc_schema.flowsheet SET album_title = 'Reménytelen' WHERE album_title = 'Rem�nytelen';
UPDATE wxyc_schema.flowsheet SET album_title = 'Ach Golgatha / Pour Que Les Fruits Mûrissent Cet Été' WHERE album_title = 'Ach Golgatha / Pour Que Les Fruits Mûrissent Cet �té';
UPDATE wxyc_schema.flowsheet SET album_title = 'Ahora Mas que Nunca' WHERE album_title = 'Ahora M�s Que Nunca';
UPDATE wxyc_schema.flowsheet SET album_title = 'Eydie Gorme' WHERE album_title = 'Eydie Gorm�';
UPDATE wxyc_schema.flowsheet SET album_title = 'L''Œil Écoute / Dedans-Dehors' WHERE album_title = 'L''�?il écoute / Dedans-Dehors';
-- The original DJ entered "League of Legends [mojibaked-dash] League Of Legends Worlds Anthems...";
-- the canonical drops the leading "League of Legends [dash]" prefix because the mojibaked dash
-- was a stray "artist — album" concatenation, not part of the release title.
UPDATE wxyc_schema.flowsheet SET album_title = 'League Of Legends Worlds Anthems - Vol. 1: 2014-2023' WHERE album_title = 'League of Legends � League Of Legends Worlds Anthems - Vol. 1: 2014-2023';
UPDATE wxyc_schema.flowsheet SET artist_name = 'Csillagrablók' WHERE artist_name = 'Csillagrabl�k';
UPDATE wxyc_schema.flowsheet SET artist_name = 'Sonido Dueñez' WHERE artist_name = 'Sonido Due�ez';
UPDATE wxyc_schema.flowsheet SET artist_name = 'Eydie Gorme' WHERE artist_name = 'Eydie Gorm�';
UPDATE wxyc_schema.flowsheet SET record_label = 'Infiné Éditions' WHERE record_label = 'Infin� Editions';
UPDATE wxyc_schema.flowsheet SET track_title = 'Mallku Diablón' WHERE track_title = 'Mallku Diabl�n';
UPDATE wxyc_schema.flowsheet SET track_title = 'Bliws Afon Tâf' WHERE track_title = 'Bliws Afon T�f';
UPDATE wxyc_schema.flowsheet SET track_title = 'Ch''uwanchaña ~El Golpe Final~' WHERE track_title = 'Ch''uwancha�a ~El Golpe Final~';
UPDATE wxyc_schema.flowsheet SET track_title = 'Convocación "Banger/Diffusion"' WHERE track_title = 'Convocaci�n "Banger/Diffusion"';
UPDATE wxyc_schema.flowsheet SET track_title = 'Plastic 100°C' WHERE track_title = 'Plastic 100�C';
UPDATE wxyc_schema.library SET album_title = 'Ballet Mécanique' WHERE album_title = 'Ballet M�canique';
UPDATE wxyc_schema.library SET album_title = 'Battles Olé' WHERE album_title = 'Battles Ol�';
UPDATE wxyc_schema.library SET album_title = 'Chansons pour le corps; Et si tout entiére maintenant' WHERE album_title = 'Chansons pour le corps; Et si tout enti�re maintenant';
UPDATE wxyc_schema.library SET album_title = 'HACE/26,250''/11° 22.4''N 142° 35.5''E' WHERE album_title = 'HACE/26,250''/11� 22.4''N 142� 35.5''E';
UPDATE wxyc_schema.library SET album_title = 'La Forêt' WHERE album_title = 'La For�t';
UPDATE wxyc_schema.library SET album_title = 'Mortelle Randonnée (Extraits De La Bande Originale Du Film)' WHERE album_title = 'Mortelle Randonn�e (Extraits de la Bande Originale du Film)';
UPDATE wxyc_schema.library SET album_title = 'Rock en Español Vol. One' WHERE album_title = 'Rock en Espa�ol Vol. One';
UPDATE wxyc_schema.library SET artist_name = 'Beyoncé' WHERE artist_name = 'Beyonc�';
UPDATE wxyc_schema.library SET artist_name = 'Damian Nisenson / Jean Félix Mailloux / Pierre Tanguay' WHERE artist_name = 'Damian Nisenson / Jean F�lix Mailloux / Pierre Tanguay';
UPDATE wxyc_schema.rotation SET album_title = 'A Sua Diversão / Não Tem Nada Não' WHERE album_title = 'A Sua Divers�o / N�o Tem Nada N�o';
UPDATE wxyc_schema.rotation SET album_title = 'Reménytelen' WHERE album_title = 'Rem�nytelen';
UPDATE wxyc_schema.rotation SET artist_name = 'Amara Toure' WHERE artist_name = 'Amare Tour�';
UPDATE wxyc_schema.rotation SET artist_name = 'Csillagrablók' WHERE artist_name = 'Csillagrabl�k';
UPDATE wxyc_schema.rotation SET artist_name = 'Kai Alcé' WHERE artist_name = 'Kai Alc�';
UPDATE wxyc_schema.rotation SET artist_name = 'Sonido Dueñez' WHERE artist_name = 'Sonido Due�ez';
UPDATE wxyc_schema.rotation SET artist_name = '}Ï{ (Louise Boghossian and Romain Vasset)' WHERE artist_name = '}�{ (Louise Boghossian and Romain Vasset)';
UPDATE wxyc_schema.rotation SET record_label = 'Infiné Éditions' WHERE record_label = 'Infin� Editions';

COMMIT;

-- ===========================================================
-- Post-amble verify: no targeted (table, column, current) tuple
-- should still match. Any non-zero count below is a regression.
-- ===========================================================
SELECT '=== V_BS_FFFD post-amble: residual count per row (expect 0) ===' AS section;
SELECT 'flowsheet' AS tbl, 'album_title' AS col, 'A Sua Divers�o / N�o Tem Nada N�o' AS lossy, (SELECT COUNT(*) FROM wxyc_schema.flowsheet WHERE album_title = 'A Sua Divers�o / N�o Tem Nada N�o') AS residual
UNION ALL
SELECT 'flowsheet' AS tbl, 'album_title' AS col, 'Music from the Caucasus � The Archive of ORED Recordings, 2013�2023' AS lossy, (SELECT COUNT(*) FROM wxyc_schema.flowsheet WHERE album_title = 'Music from the Caucasus � The Archive of ORED Recordings, 2013�2023') AS residual
UNION ALL
SELECT 'flowsheet' AS tbl, 'album_title' AS col, 'Rem�nytelen' AS lossy, (SELECT COUNT(*) FROM wxyc_schema.flowsheet WHERE album_title = 'Rem�nytelen') AS residual
UNION ALL
SELECT 'flowsheet' AS tbl, 'album_title' AS col, 'Ach Golgatha / Pour Que Les Fruits Mûrissent Cet �té' AS lossy, (SELECT COUNT(*) FROM wxyc_schema.flowsheet WHERE album_title = 'Ach Golgatha / Pour Que Les Fruits Mûrissent Cet �té') AS residual
UNION ALL
SELECT 'flowsheet' AS tbl, 'album_title' AS col, 'Ahora M�s Que Nunca' AS lossy, (SELECT COUNT(*) FROM wxyc_schema.flowsheet WHERE album_title = 'Ahora M�s Que Nunca') AS residual
UNION ALL
SELECT 'flowsheet' AS tbl, 'album_title' AS col, 'Eydie Gorm�' AS lossy, (SELECT COUNT(*) FROM wxyc_schema.flowsheet WHERE album_title = 'Eydie Gorm�') AS residual
UNION ALL
SELECT 'flowsheet' AS tbl, 'album_title' AS col, 'L''�?il écoute / Dedans-Dehors' AS lossy, (SELECT COUNT(*) FROM wxyc_schema.flowsheet WHERE album_title = 'L''�?il écoute / Dedans-Dehors') AS residual
UNION ALL
SELECT 'flowsheet' AS tbl, 'album_title' AS col, 'League of Legends � League Of Legends Worlds Anthems - Vol. 1: 2014-2023' AS lossy, (SELECT COUNT(*) FROM wxyc_schema.flowsheet WHERE album_title = 'League of Legends � League Of Legends Worlds Anthems - Vol. 1: 2014-2023') AS residual
UNION ALL
SELECT 'flowsheet' AS tbl, 'artist_name' AS col, 'Csillagrabl�k' AS lossy, (SELECT COUNT(*) FROM wxyc_schema.flowsheet WHERE artist_name = 'Csillagrabl�k') AS residual
UNION ALL
SELECT 'flowsheet' AS tbl, 'artist_name' AS col, 'Sonido Due�ez' AS lossy, (SELECT COUNT(*) FROM wxyc_schema.flowsheet WHERE artist_name = 'Sonido Due�ez') AS residual
UNION ALL
SELECT 'flowsheet' AS tbl, 'artist_name' AS col, 'Eydie Gorm�' AS lossy, (SELECT COUNT(*) FROM wxyc_schema.flowsheet WHERE artist_name = 'Eydie Gorm�') AS residual
UNION ALL
SELECT 'flowsheet' AS tbl, 'record_label' AS col, 'Infin� Editions' AS lossy, (SELECT COUNT(*) FROM wxyc_schema.flowsheet WHERE record_label = 'Infin� Editions') AS residual
UNION ALL
SELECT 'flowsheet' AS tbl, 'track_title' AS col, 'Mallku Diabl�n' AS lossy, (SELECT COUNT(*) FROM wxyc_schema.flowsheet WHERE track_title = 'Mallku Diabl�n') AS residual
UNION ALL
SELECT 'flowsheet' AS tbl, 'track_title' AS col, 'Bliws Afon T�f' AS lossy, (SELECT COUNT(*) FROM wxyc_schema.flowsheet WHERE track_title = 'Bliws Afon T�f') AS residual
UNION ALL
SELECT 'flowsheet' AS tbl, 'track_title' AS col, 'Ch''uwancha�a ~El Golpe Final~' AS lossy, (SELECT COUNT(*) FROM wxyc_schema.flowsheet WHERE track_title = 'Ch''uwancha�a ~El Golpe Final~') AS residual
UNION ALL
SELECT 'flowsheet' AS tbl, 'track_title' AS col, 'Convocaci�n "Banger/Diffusion"' AS lossy, (SELECT COUNT(*) FROM wxyc_schema.flowsheet WHERE track_title = 'Convocaci�n "Banger/Diffusion"') AS residual
UNION ALL
SELECT 'flowsheet' AS tbl, 'track_title' AS col, 'Plastic 100�C' AS lossy, (SELECT COUNT(*) FROM wxyc_schema.flowsheet WHERE track_title = 'Plastic 100�C') AS residual
UNION ALL
SELECT 'library' AS tbl, 'album_title' AS col, 'Ballet M�canique' AS lossy, (SELECT COUNT(*) FROM wxyc_schema.library WHERE album_title = 'Ballet M�canique') AS residual
UNION ALL
SELECT 'library' AS tbl, 'album_title' AS col, 'Battles Ol�' AS lossy, (SELECT COUNT(*) FROM wxyc_schema.library WHERE album_title = 'Battles Ol�') AS residual
UNION ALL
SELECT 'library' AS tbl, 'album_title' AS col, 'Chansons pour le corps; Et si tout enti�re maintenant' AS lossy, (SELECT COUNT(*) FROM wxyc_schema.library WHERE album_title = 'Chansons pour le corps; Et si tout enti�re maintenant') AS residual
UNION ALL
SELECT 'library' AS tbl, 'album_title' AS col, 'HACE/26,250''/11� 22.4''N 142� 35.5''E' AS lossy, (SELECT COUNT(*) FROM wxyc_schema.library WHERE album_title = 'HACE/26,250''/11� 22.4''N 142� 35.5''E') AS residual
UNION ALL
SELECT 'library' AS tbl, 'album_title' AS col, 'La For�t' AS lossy, (SELECT COUNT(*) FROM wxyc_schema.library WHERE album_title = 'La For�t') AS residual
UNION ALL
SELECT 'library' AS tbl, 'album_title' AS col, 'Mortelle Randonn�e (Extraits de la Bande Originale du Film)' AS lossy, (SELECT COUNT(*) FROM wxyc_schema.library WHERE album_title = 'Mortelle Randonn�e (Extraits de la Bande Originale du Film)') AS residual
UNION ALL
SELECT 'library' AS tbl, 'album_title' AS col, 'Rock en Espa�ol Vol. One' AS lossy, (SELECT COUNT(*) FROM wxyc_schema.library WHERE album_title = 'Rock en Espa�ol Vol. One') AS residual
UNION ALL
SELECT 'library' AS tbl, 'artist_name' AS col, 'Beyonc�' AS lossy, (SELECT COUNT(*) FROM wxyc_schema.library WHERE artist_name = 'Beyonc�') AS residual
UNION ALL
SELECT 'library' AS tbl, 'artist_name' AS col, 'Damian Nisenson / Jean F�lix Mailloux / Pierre Tanguay' AS lossy, (SELECT COUNT(*) FROM wxyc_schema.library WHERE artist_name = 'Damian Nisenson / Jean F�lix Mailloux / Pierre Tanguay') AS residual
UNION ALL
SELECT 'rotation' AS tbl, 'album_title' AS col, 'A Sua Divers�o / N�o Tem Nada N�o' AS lossy, (SELECT COUNT(*) FROM wxyc_schema.rotation WHERE album_title = 'A Sua Divers�o / N�o Tem Nada N�o') AS residual
UNION ALL
SELECT 'rotation' AS tbl, 'album_title' AS col, 'Rem�nytelen' AS lossy, (SELECT COUNT(*) FROM wxyc_schema.rotation WHERE album_title = 'Rem�nytelen') AS residual
UNION ALL
SELECT 'rotation' AS tbl, 'artist_name' AS col, 'Amare Tour�' AS lossy, (SELECT COUNT(*) FROM wxyc_schema.rotation WHERE artist_name = 'Amare Tour�') AS residual
UNION ALL
SELECT 'rotation' AS tbl, 'artist_name' AS col, 'Csillagrabl�k' AS lossy, (SELECT COUNT(*) FROM wxyc_schema.rotation WHERE artist_name = 'Csillagrabl�k') AS residual
UNION ALL
SELECT 'rotation' AS tbl, 'artist_name' AS col, 'Kai Alc�' AS lossy, (SELECT COUNT(*) FROM wxyc_schema.rotation WHERE artist_name = 'Kai Alc�') AS residual
UNION ALL
SELECT 'rotation' AS tbl, 'artist_name' AS col, 'Sonido Due�ez' AS lossy, (SELECT COUNT(*) FROM wxyc_schema.rotation WHERE artist_name = 'Sonido Due�ez') AS residual
UNION ALL
SELECT 'rotation' AS tbl, 'artist_name' AS col, '}�{ (Louise Boghossian and Romain Vasset)' AS lossy, (SELECT COUNT(*) FROM wxyc_schema.rotation WHERE artist_name = '}�{ (Louise Boghossian and Romain Vasset)') AS residual
UNION ALL
SELECT 'rotation' AS tbl, 'record_label' AS col, 'Infin� Editions' AS lossy, (SELECT COUNT(*) FROM wxyc_schema.rotation WHERE record_label = 'Infin� Editions') AS residual
ORDER BY residual DESC, tbl, col;

-- Overall verify: total rows still containing U+FFFD in any
-- targeted column. The dropped rows (Arh?, ???, Acc?sed,
-- GER?USCHMANUFAKTUR) intentionally remain — this count won't
-- hit zero, but it should be small (<= the dropped-row total).
SELECT 'AFTER — residual U+FFFD across targeted columns' AS section;
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
