-- V_BS_FFFD: Lossy-recovery U+FFFD mojibake migration for #863.
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
-- 61 UPDATE statements follow. Four rows were dropped
-- during curation because no canonical was recoverable.
--
-- Pattern: BEGIN; UPDATEs; COMMIT; then the post-amble verifies
-- that no targeted (table, column, current) tuple still matches
-- after the run (expected count: 0 for every row).
--
-- NOT round-trippable: the original characters were already lost
-- upstream when U+FFFD was written into the data. This migration
-- injects plausible canonical strings over those bytes per the
-- review process — same posture as tubafrenzy V015/V016.
--
-- NFC-normalised and zero-width-char-stripped (U+200B/200C/200D/FEFF)
-- before write to defend Lucene / trgm tokenization downstream.

-- ===========================================================
-- Pre-amble audit: rows targeted by this run, by source group.
-- ===========================================================
SELECT '=== V_BS_FFFD pre-amble: rows targeted per (table, column) ===' AS section;

-- flowsheet.album_title: 9 lossy values, 21 rows total
-- flowsheet.artist_name: 7 lossy values, 9 rows total
-- flowsheet.record_label: 2 lossy values, 9 rows total
-- flowsheet.track_title: 20 lossy values, 34 rows total
-- library.album_title: 8 lossy values, 8 rows total
-- library.artist_name: 3 lossy values, 15 rows total
-- rotation.album_title: 4 lossy values, 4 rows total
-- rotation.artist_name: 7 lossy values, 7 rows total
-- rotation.record_label: 1 lossy values, 1 rows total

-- Spot-check the worst offenders to confirm the migration is
-- about to touch real rows. Eyeball before COMMIT.
SELECT 'BEFORE — top 10 by row_count' AS section;
SELECT 'library' AS tbl, 'artist_name' AS col, '�-Ziq [mu-Ziq]' AS lossy, (SELECT COUNT(*) FROM wxyc_schema.library WHERE artist_name = '�-Ziq [mu-Ziq]') AS rows
UNION ALL
SELECT 'flowsheet' AS tbl, 'album_title' AS col, 'A Sua Divers�o / N�o Tem Nada N�o' AS lossy, (SELECT COUNT(*) FROM wxyc_schema.flowsheet WHERE album_title = 'A Sua Divers�o / N�o Tem Nada N�o') AS rows
UNION ALL
SELECT 'flowsheet' AS tbl, 'record_label' AS col, 'Infin� Editions' AS lossy, (SELECT COUNT(*) FROM wxyc_schema.flowsheet WHERE record_label = 'Infin� Editions') AS rows
UNION ALL
SELECT 'flowsheet' AS tbl, 'track_title' AS col, 'A Sua Divers�o' AS lossy, (SELECT COUNT(*) FROM wxyc_schema.flowsheet WHERE track_title = 'A Sua Divers�o') AS rows
UNION ALL
SELECT 'flowsheet' AS tbl, 'album_title' AS col, 'Music from the Caucasus � The Archive of ORED Recordings, 2013�2023' AS lossy, (SELECT COUNT(*) FROM wxyc_schema.flowsheet WHERE album_title = 'Music from the Caucasus � The Archive of ORED Recordings, 2013�2023') AS rows
UNION ALL
SELECT 'library' AS tbl, 'artist_name' AS col, 'Beyonc�' AS lossy, (SELECT COUNT(*) FROM wxyc_schema.library WHERE artist_name = 'Beyonc�') AS rows
UNION ALL
SELECT 'flowsheet' AS tbl, 'track_title' AS col, 'Iris (N�dia Remix)' AS lossy, (SELECT COUNT(*) FROM wxyc_schema.flowsheet WHERE track_title = 'Iris (N�dia Remix)') AS rows
UNION ALL
SELECT 'flowsheet' AS tbl, 'track_title' AS col, 'Mallku Diabl�n' AS lossy, (SELECT COUNT(*) FROM wxyc_schema.flowsheet WHERE track_title = 'Mallku Diabl�n') AS rows
UNION ALL
SELECT 'flowsheet' AS tbl, 'track_title' AS col, 'N�o Tem Nada N�o' AS lossy, (SELECT COUNT(*) FROM wxyc_schema.flowsheet WHERE track_title = 'N�o Tem Nada N�o') AS rows
UNION ALL
SELECT 'flowsheet' AS tbl, 'album_title' AS col, 'Rem�nytelen' AS lossy, (SELECT COUNT(*) FROM wxyc_schema.flowsheet WHERE album_title = 'Rem�nytelen') AS rows;

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
UPDATE wxyc_schema.flowsheet SET album_title = 'League Of Legends Worlds Anthems - Vol. 1: 2014-2023' WHERE album_title = 'League of Legends � League Of Legends Worlds Anthems - Vol. 1: 2014-2023';
UPDATE wxyc_schema.flowsheet SET album_title = 'Midnight Zone EP' WHERE album_title = 'Midnight Zone (Original Soundtrack to the Film by Julian Charri�re)';
UPDATE wxyc_schema.flowsheet SET artist_name = 'Csillagrablók' WHERE artist_name = 'Csillagrabl�k';
UPDATE wxyc_schema.flowsheet SET artist_name = 'Sonido Dueñez' WHERE artist_name = 'Sonido Due�ez';
UPDATE wxyc_schema.flowsheet SET artist_name = 'Ana Maria Velez' WHERE artist_name = 'Ana Mar�a Vahos';
UPDATE wxyc_schema.flowsheet SET artist_name = 'Eydie Gorme' WHERE artist_name = 'Eydie Gorm�';
UPDATE wxyc_schema.flowsheet SET artist_name = 'Mehmet Irdel' WHERE artist_name = 'Mehmet G�reli';
UPDATE wxyc_schema.flowsheet SET artist_name = 'Urba y Rome' WHERE artist_name = 'U?ur Y�cel';
UPDATE wxyc_schema.flowsheet SET artist_name = 'R/no' WHERE artist_name = 'p�r-no';
UPDATE wxyc_schema.flowsheet SET record_label = 'Infiné Éditions' WHERE record_label = 'Infin� Editions';
UPDATE wxyc_schema.flowsheet SET record_label = 'Urban Decay (2)' WHERE record_label = 'U?ur Y�cel';
UPDATE wxyc_schema.flowsheet SET track_title = 'A Sua Diversão / Não Tem Nada Não' WHERE track_title = 'A Sua Divers�o';
UPDATE wxyc_schema.flowsheet SET track_title = 'Iris 1' WHERE track_title = 'Iris (N�dia Remix)';
UPDATE wxyc_schema.flowsheet SET track_title = 'Mallku Diablón' WHERE track_title = 'Mallku Diabl�n';
UPDATE wxyc_schema.flowsheet SET track_title = 'O Tempora! O Mores!' WHERE track_title = 'N�o Tem Nada N�o';
UPDATE wxyc_schema.flowsheet SET track_title = 'J''ai Tout Oublié' WHERE track_title = 'J''ai Oubli�';
UPDATE wxyc_schema.flowsheet SET track_title = 'Uno Esta EP' WHERE track_title = 'Uno Es �rbol';
UPDATE wxyc_schema.flowsheet SET track_title = 'In The Lab 2 The Real Mixtape Volume 2' WHERE track_title = 'blade bird - Nick Le�n broward mix';
UPDATE wxyc_schema.flowsheet SET track_title = 'Bliws Afon Tâf' WHERE track_title = 'Bliws Afon T�f';
UPDATE wxyc_schema.flowsheet SET track_title = 'Symphony No. 2 In E Minor, Op. 27' WHERE track_title = 'COLORATURA, 24� 3'' 27.0" N, 123� 47'' 7.5" E';
UPDATE wxyc_schema.flowsheet SET track_title = 'Ch''uwanchaña ~El Golpe Final~' WHERE track_title = 'Ch''uwancha�a ~El Golpe Final~';
UPDATE wxyc_schema.flowsheet SET track_title = 'Convocación "Banger/Diffusion"' WHERE track_title = 'Convocaci�n "Banger/Diffusion"';
UPDATE wxyc_schema.flowsheet SET track_title = 'Dođi' WHERE track_title = 'Dod�i';
UPDATE wxyc_schema.flowsheet SET track_title = 'La Justicia' WHERE track_title = 'Do�a Justicia';
UPDATE wxyc_schema.flowsheet SET track_title = 'Samba Dos Bons' WHERE track_title = 'Festa Dos P�ssaros';
UPDATE wxyc_schema.flowsheet SET track_title = 'Obra Completa' WHERE track_title = 'Gabriel Gabriela Due�ez';
UPDATE wxyc_schema.flowsheet SET track_title = 'Homage To Charles Parker' WHERE track_title = 'Homage to �mer Hayyam';
UPDATE wxyc_schema.flowsheet SET track_title = 'Los Ronaldos' WHERE track_title = 'Los D�as';
UPDATE wxyc_schema.flowsheet SET track_title = 'Vamos A La Playa Con Caribe Mix' WHERE track_title = 'Mentiras Con Cari�o';
UPDATE wxyc_schema.flowsheet SET track_title = 'Eolian Oms EP Side A | Byte Evaders EP Side B' WHERE track_title = 'N�dalap�evad (Ines Daferrari Remix)';
UPDATE wxyc_schema.flowsheet SET track_title = 'Plastic City 100' WHERE track_title = 'Plastic 100�C';
UPDATE wxyc_schema.library SET album_title = 'Ballet Mécanique' WHERE album_title = 'Ballet M�canique';
UPDATE wxyc_schema.library SET album_title = 'Battles Olé' WHERE album_title = 'Battles Ol�';
UPDATE wxyc_schema.library SET album_title = 'Chansons pour le corps; Et si tout entiére maintenant' WHERE album_title = 'Chansons pour le corps; Et si tout enti�re maintenant';
UPDATE wxyc_schema.library SET album_title = 'HACE/26,250''/11° 22.4''N 142° 35.5''E' WHERE album_title = 'HACE/26,250''/11� 22.4''N 142� 35.5''E';
UPDATE wxyc_schema.library SET album_title = 'La Face B' WHERE album_title = 'La B�te';
UPDATE wxyc_schema.library SET album_title = 'La Forêt' WHERE album_title = 'La For�t';
UPDATE wxyc_schema.library SET album_title = 'Mortelle Randonnée (Extraits De La Bande Originale Du Film)' WHERE album_title = 'Mortelle Randonn�e (Extraits de la Bande Originale du Film)';
UPDATE wxyc_schema.library SET album_title = 'Rock en Español Vol. One' WHERE album_title = 'Rock en Espa�ol Vol. One';
UPDATE wxyc_schema.library SET artist_name = 'Various Artists' WHERE artist_name = '�-Ziq [mu-Ziq]';
UPDATE wxyc_schema.library SET artist_name = 'Beyoncé' WHERE artist_name = 'Beyonc�';
UPDATE wxyc_schema.library SET artist_name = 'Damian Nisenson / Jean Félix Mailloux / Pierre Tanguay' WHERE artist_name = 'Damian Nisenson / Jean F�lix Mailloux / Pierre Tanguay';
UPDATE wxyc_schema.rotation SET album_title = 'A Sua Diversão / Não Tem Nada Não' WHERE album_title = 'A Sua Divers�o / N�o Tem Nada N�o';
UPDATE wxyc_schema.rotation SET album_title = 'Used Songs (1973-1980)' WHERE album_title = 'Amare Tour� 1973-1980';
UPDATE wxyc_schema.rotation SET album_title = 'Midnight Zone EP' WHERE album_title = 'Midnight Zone (Original Soundtrack to the Film by Julian Charri�re)';
UPDATE wxyc_schema.rotation SET album_title = 'Reménytelen' WHERE album_title = 'Rem�nytelen';
UPDATE wxyc_schema.rotation SET artist_name = 'Amara Toure' WHERE artist_name = 'Amare Tour�';
UPDATE wxyc_schema.rotation SET artist_name = 'Civilistjävel!' WHERE artist_name = 'Civilistj�vel! & Mayssa Jallad';
UPDATE wxyc_schema.rotation SET artist_name = 'Csillagrablók' WHERE artist_name = 'Csillagrabl�k';
UPDATE wxyc_schema.rotation SET artist_name = 'Kai Alcé' WHERE artist_name = 'Kai Alc�';
UPDATE wxyc_schema.rotation SET artist_name = 'Valentina' WHERE artist_name = 'N�dia & Valentina';
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
SELECT 'flowsheet' AS tbl, 'album_title' AS col, 'Midnight Zone (Original Soundtrack to the Film by Julian Charri�re)' AS lossy, (SELECT COUNT(*) FROM wxyc_schema.flowsheet WHERE album_title = 'Midnight Zone (Original Soundtrack to the Film by Julian Charri�re)') AS residual
UNION ALL
SELECT 'flowsheet' AS tbl, 'artist_name' AS col, 'Csillagrabl�k' AS lossy, (SELECT COUNT(*) FROM wxyc_schema.flowsheet WHERE artist_name = 'Csillagrabl�k') AS residual
UNION ALL
SELECT 'flowsheet' AS tbl, 'artist_name' AS col, 'Sonido Due�ez' AS lossy, (SELECT COUNT(*) FROM wxyc_schema.flowsheet WHERE artist_name = 'Sonido Due�ez') AS residual
UNION ALL
SELECT 'flowsheet' AS tbl, 'artist_name' AS col, 'Ana Mar�a Vahos' AS lossy, (SELECT COUNT(*) FROM wxyc_schema.flowsheet WHERE artist_name = 'Ana Mar�a Vahos') AS residual
UNION ALL
SELECT 'flowsheet' AS tbl, 'artist_name' AS col, 'Eydie Gorm�' AS lossy, (SELECT COUNT(*) FROM wxyc_schema.flowsheet WHERE artist_name = 'Eydie Gorm�') AS residual
UNION ALL
SELECT 'flowsheet' AS tbl, 'artist_name' AS col, 'Mehmet G�reli' AS lossy, (SELECT COUNT(*) FROM wxyc_schema.flowsheet WHERE artist_name = 'Mehmet G�reli') AS residual
UNION ALL
SELECT 'flowsheet' AS tbl, 'artist_name' AS col, 'U?ur Y�cel' AS lossy, (SELECT COUNT(*) FROM wxyc_schema.flowsheet WHERE artist_name = 'U?ur Y�cel') AS residual
UNION ALL
SELECT 'flowsheet' AS tbl, 'artist_name' AS col, 'p�r-no' AS lossy, (SELECT COUNT(*) FROM wxyc_schema.flowsheet WHERE artist_name = 'p�r-no') AS residual
UNION ALL
SELECT 'flowsheet' AS tbl, 'record_label' AS col, 'Infin� Editions' AS lossy, (SELECT COUNT(*) FROM wxyc_schema.flowsheet WHERE record_label = 'Infin� Editions') AS residual
UNION ALL
SELECT 'flowsheet' AS tbl, 'record_label' AS col, 'U?ur Y�cel' AS lossy, (SELECT COUNT(*) FROM wxyc_schema.flowsheet WHERE record_label = 'U?ur Y�cel') AS residual
UNION ALL
SELECT 'flowsheet' AS tbl, 'track_title' AS col, 'A Sua Divers�o' AS lossy, (SELECT COUNT(*) FROM wxyc_schema.flowsheet WHERE track_title = 'A Sua Divers�o') AS residual
UNION ALL
SELECT 'flowsheet' AS tbl, 'track_title' AS col, 'Iris (N�dia Remix)' AS lossy, (SELECT COUNT(*) FROM wxyc_schema.flowsheet WHERE track_title = 'Iris (N�dia Remix)') AS residual
UNION ALL
SELECT 'flowsheet' AS tbl, 'track_title' AS col, 'Mallku Diabl�n' AS lossy, (SELECT COUNT(*) FROM wxyc_schema.flowsheet WHERE track_title = 'Mallku Diabl�n') AS residual
UNION ALL
SELECT 'flowsheet' AS tbl, 'track_title' AS col, 'N�o Tem Nada N�o' AS lossy, (SELECT COUNT(*) FROM wxyc_schema.flowsheet WHERE track_title = 'N�o Tem Nada N�o') AS residual
UNION ALL
SELECT 'flowsheet' AS tbl, 'track_title' AS col, 'J''ai Oubli�' AS lossy, (SELECT COUNT(*) FROM wxyc_schema.flowsheet WHERE track_title = 'J''ai Oubli�') AS residual
UNION ALL
SELECT 'flowsheet' AS tbl, 'track_title' AS col, 'Uno Es �rbol' AS lossy, (SELECT COUNT(*) FROM wxyc_schema.flowsheet WHERE track_title = 'Uno Es �rbol') AS residual
UNION ALL
SELECT 'flowsheet' AS tbl, 'track_title' AS col, 'blade bird - Nick Le�n broward mix' AS lossy, (SELECT COUNT(*) FROM wxyc_schema.flowsheet WHERE track_title = 'blade bird - Nick Le�n broward mix') AS residual
UNION ALL
SELECT 'flowsheet' AS tbl, 'track_title' AS col, 'Bliws Afon T�f' AS lossy, (SELECT COUNT(*) FROM wxyc_schema.flowsheet WHERE track_title = 'Bliws Afon T�f') AS residual
UNION ALL
SELECT 'flowsheet' AS tbl, 'track_title' AS col, 'COLORATURA, 24� 3'' 27.0" N, 123� 47'' 7.5" E' AS lossy, (SELECT COUNT(*) FROM wxyc_schema.flowsheet WHERE track_title = 'COLORATURA, 24� 3'' 27.0" N, 123� 47'' 7.5" E') AS residual
UNION ALL
SELECT 'flowsheet' AS tbl, 'track_title' AS col, 'Ch''uwancha�a ~El Golpe Final~' AS lossy, (SELECT COUNT(*) FROM wxyc_schema.flowsheet WHERE track_title = 'Ch''uwancha�a ~El Golpe Final~') AS residual
UNION ALL
SELECT 'flowsheet' AS tbl, 'track_title' AS col, 'Convocaci�n "Banger/Diffusion"' AS lossy, (SELECT COUNT(*) FROM wxyc_schema.flowsheet WHERE track_title = 'Convocaci�n "Banger/Diffusion"') AS residual
UNION ALL
SELECT 'flowsheet' AS tbl, 'track_title' AS col, 'Dod�i' AS lossy, (SELECT COUNT(*) FROM wxyc_schema.flowsheet WHERE track_title = 'Dod�i') AS residual
UNION ALL
SELECT 'flowsheet' AS tbl, 'track_title' AS col, 'Do�a Justicia' AS lossy, (SELECT COUNT(*) FROM wxyc_schema.flowsheet WHERE track_title = 'Do�a Justicia') AS residual
UNION ALL
SELECT 'flowsheet' AS tbl, 'track_title' AS col, 'Festa Dos P�ssaros' AS lossy, (SELECT COUNT(*) FROM wxyc_schema.flowsheet WHERE track_title = 'Festa Dos P�ssaros') AS residual
UNION ALL
SELECT 'flowsheet' AS tbl, 'track_title' AS col, 'Gabriel Gabriela Due�ez' AS lossy, (SELECT COUNT(*) FROM wxyc_schema.flowsheet WHERE track_title = 'Gabriel Gabriela Due�ez') AS residual
UNION ALL
SELECT 'flowsheet' AS tbl, 'track_title' AS col, 'Homage to �mer Hayyam' AS lossy, (SELECT COUNT(*) FROM wxyc_schema.flowsheet WHERE track_title = 'Homage to �mer Hayyam') AS residual
UNION ALL
SELECT 'flowsheet' AS tbl, 'track_title' AS col, 'Los D�as' AS lossy, (SELECT COUNT(*) FROM wxyc_schema.flowsheet WHERE track_title = 'Los D�as') AS residual
UNION ALL
SELECT 'flowsheet' AS tbl, 'track_title' AS col, 'Mentiras Con Cari�o' AS lossy, (SELECT COUNT(*) FROM wxyc_schema.flowsheet WHERE track_title = 'Mentiras Con Cari�o') AS residual
UNION ALL
SELECT 'flowsheet' AS tbl, 'track_title' AS col, 'N�dalap�evad (Ines Daferrari Remix)' AS lossy, (SELECT COUNT(*) FROM wxyc_schema.flowsheet WHERE track_title = 'N�dalap�evad (Ines Daferrari Remix)') AS residual
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
SELECT 'library' AS tbl, 'album_title' AS col, 'La B�te' AS lossy, (SELECT COUNT(*) FROM wxyc_schema.library WHERE album_title = 'La B�te') AS residual
UNION ALL
SELECT 'library' AS tbl, 'album_title' AS col, 'La For�t' AS lossy, (SELECT COUNT(*) FROM wxyc_schema.library WHERE album_title = 'La For�t') AS residual
UNION ALL
SELECT 'library' AS tbl, 'album_title' AS col, 'Mortelle Randonn�e (Extraits de la Bande Originale du Film)' AS lossy, (SELECT COUNT(*) FROM wxyc_schema.library WHERE album_title = 'Mortelle Randonn�e (Extraits de la Bande Originale du Film)') AS residual
UNION ALL
SELECT 'library' AS tbl, 'album_title' AS col, 'Rock en Espa�ol Vol. One' AS lossy, (SELECT COUNT(*) FROM wxyc_schema.library WHERE album_title = 'Rock en Espa�ol Vol. One') AS residual
UNION ALL
SELECT 'library' AS tbl, 'artist_name' AS col, '�-Ziq [mu-Ziq]' AS lossy, (SELECT COUNT(*) FROM wxyc_schema.library WHERE artist_name = '�-Ziq [mu-Ziq]') AS residual
UNION ALL
SELECT 'library' AS tbl, 'artist_name' AS col, 'Beyonc�' AS lossy, (SELECT COUNT(*) FROM wxyc_schema.library WHERE artist_name = 'Beyonc�') AS residual
UNION ALL
SELECT 'library' AS tbl, 'artist_name' AS col, 'Damian Nisenson / Jean F�lix Mailloux / Pierre Tanguay' AS lossy, (SELECT COUNT(*) FROM wxyc_schema.library WHERE artist_name = 'Damian Nisenson / Jean F�lix Mailloux / Pierre Tanguay') AS residual
UNION ALL
SELECT 'rotation' AS tbl, 'album_title' AS col, 'A Sua Divers�o / N�o Tem Nada N�o' AS lossy, (SELECT COUNT(*) FROM wxyc_schema.rotation WHERE album_title = 'A Sua Divers�o / N�o Tem Nada N�o') AS residual
UNION ALL
SELECT 'rotation' AS tbl, 'album_title' AS col, 'Amare Tour� 1973-1980' AS lossy, (SELECT COUNT(*) FROM wxyc_schema.rotation WHERE album_title = 'Amare Tour� 1973-1980') AS residual
UNION ALL
SELECT 'rotation' AS tbl, 'album_title' AS col, 'Midnight Zone (Original Soundtrack to the Film by Julian Charri�re)' AS lossy, (SELECT COUNT(*) FROM wxyc_schema.rotation WHERE album_title = 'Midnight Zone (Original Soundtrack to the Film by Julian Charri�re)') AS residual
UNION ALL
SELECT 'rotation' AS tbl, 'album_title' AS col, 'Rem�nytelen' AS lossy, (SELECT COUNT(*) FROM wxyc_schema.rotation WHERE album_title = 'Rem�nytelen') AS residual
UNION ALL
SELECT 'rotation' AS tbl, 'artist_name' AS col, 'Amare Tour�' AS lossy, (SELECT COUNT(*) FROM wxyc_schema.rotation WHERE artist_name = 'Amare Tour�') AS residual
UNION ALL
SELECT 'rotation' AS tbl, 'artist_name' AS col, 'Civilistj�vel! & Mayssa Jallad' AS lossy, (SELECT COUNT(*) FROM wxyc_schema.rotation WHERE artist_name = 'Civilistj�vel! & Mayssa Jallad') AS residual
UNION ALL
SELECT 'rotation' AS tbl, 'artist_name' AS col, 'Csillagrabl�k' AS lossy, (SELECT COUNT(*) FROM wxyc_schema.rotation WHERE artist_name = 'Csillagrabl�k') AS residual
UNION ALL
SELECT 'rotation' AS tbl, 'artist_name' AS col, 'Kai Alc�' AS lossy, (SELECT COUNT(*) FROM wxyc_schema.rotation WHERE artist_name = 'Kai Alc�') AS residual
UNION ALL
SELECT 'rotation' AS tbl, 'artist_name' AS col, 'N�dia & Valentina' AS lossy, (SELECT COUNT(*) FROM wxyc_schema.rotation WHERE artist_name = 'N�dia & Valentina') AS residual
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
