-- 0066: Replay 0064's V012 mojibake propagation, skipped by drizzle's cursor.
--
-- 0064 was committed with when=1778683200000, then 0065 landed with
-- when=1779683200001 (one millisecond above the original cursor) to recover
-- five other migrations the same cursor bug had stranded earlier (#511).
-- That bumped drizzle's max(applied_when) cursor to 1779683200001, which
-- pushed 0064 below the cursor — drizzle now skips it on every migrate
-- run, the verifier in init-db.mjs reports it missing, migrate exits 1,
-- and Auto Build & Deploy halts before the deploy step.
--
-- This file replays 0064's full effect at when=1779683200002 (two ms above
-- the original cursor) so drizzle's cursor advances past it cleanly.
-- Future migrations should land at the next monotonic timestamp above this.
--
-- Idempotent by construction: every UPDATE is value-keyed (WHERE col =
-- corrupted_form). A re-run against an already-corrected row matches
-- nothing and is a no-op. That property is what makes splitting the
-- replay into a new migration safe — it does not matter whether 0064
-- ever ran on this database, ever ran partially, or ran fully; the end
-- state is the same.
--
-- 33 UPDATE statements covering 52 rows in wxyc_schema.flowsheet across
-- four text columns. Source of truth: M0.1 audit (PR #529,
-- audit/bs_mojibake_audit.csv). Identical to 0064's body — see that file
-- for the parent epic and project context (WXYC/docs#6).
--
-- Permanent gap in __drizzle_migrations: 0064's hash will never have a
-- row, by design. The validator and verifier both already tolerate this
-- shape via the same path they tolerate the 0054/0055/0056/0062/0063
-- gaps from #551. Audit tooling cross-referencing journal vs applied
-- should treat 0064 as "expected absent."

-- artist_name: 6 distinct values, 17 rows
UPDATE wxyc_schema.flowsheet SET artist_name = 'μ-Ziq' WHERE artist_name = 'Î¼-Ziq';
UPDATE wxyc_schema.flowsheet SET artist_name = 'GrOun士 + Kabamix' WHERE artist_name = 'GrOunå£« + Kabamix';
UPDATE wxyc_schema.flowsheet SET artist_name = 'Luboš Fišer' WHERE artist_name = 'LuboÅ¡ FiÅ¡er';
UPDATE wxyc_schema.flowsheet SET artist_name = 'Mustafah ''Abd Al''-Azīz' WHERE artist_name = 'Mustafah ''Abd Al''-AzÄ«z';
UPDATE wxyc_schema.flowsheet SET artist_name = 'Σtella, Las Palabras' WHERE artist_name = 'Î£tella, Las Palabras';
UPDATE wxyc_schema.flowsheet SET artist_name = 'μ-ziq' WHERE artist_name = 'Î¼-ziq';
-- track_title: 17 distinct values, 23 rows
UPDATE wxyc_schema.flowsheet SET track_title = 'ΩΩΩ' WHERE track_title = 'Î©Î©Î©';
UPDATE wxyc_schema.flowsheet SET track_title = 'Helvacı' WHERE track_title = 'HelvacÄ±';
UPDATE wxyc_schema.flowsheet SET track_title = '｡.･BLUSH･.｡' WHERE track_title = 'ï½¡.ï½¥BLUSHï½¥.ï½¡';
UPDATE wxyc_schema.flowsheet SET track_title = '400米' WHERE track_title = '400ç±³';
UPDATE wxyc_schema.flowsheet SET track_title = '78 Yilinin En Uzun Dakikası' WHERE track_title = '78 Yilinin En Uzun DakikasÄ±';
UPDATE wxyc_schema.flowsheet SET track_title = 'Daša' WHERE track_title = 'DaÅ¡a';
UPDATE wxyc_schema.flowsheet SET track_title = 'Desgraca̧da' WHERE track_title = 'DesgracaÌ§da';
UPDATE wxyc_schema.flowsheet SET track_title = 'Gadżet elektroniczny' WHERE track_title = 'GadÅ¼et elektroniczny';
UPDATE wxyc_schema.flowsheet SET track_title = 'Hidden Power (Phase δ)' WHERE track_title = 'Hidden Power (Phase Î´)';
UPDATE wxyc_schema.flowsheet SET track_title = 'Još Jedna Crta' WHERE track_title = 'JoÅ¡ Jedna Crta';
UPDATE wxyc_schema.flowsheet SET track_title = 'Poznaješ Li Moje Pravo Lice' WHERE track_title = 'PoznajeÅ¡ Li Moje Pravo Lice';
UPDATE wxyc_schema.flowsheet SET track_title = 'Yalnızlar Rıhtımı' WHERE track_title = 'YalnÄ±zlar RÄ±htÄ±mÄ±';
UPDATE wxyc_schema.flowsheet SET track_title = 'tno doɹp' WHERE track_title = 'tno doÉ¹p';
UPDATE wxyc_schema.flowsheet SET track_title = 'Ševa' WHERE track_title = 'Å eva';
UPDATE wxyc_schema.flowsheet SET track_title = 'što me vikas, šefijo' WHERE track_title = 'Å¡to me vikas, Å¡efijo';
UPDATE wxyc_schema.flowsheet SET track_title = 'два TWO' WHERE track_title = 'Ð´Ð²Ð° TWO';
UPDATE wxyc_schema.flowsheet SET track_title = '夢中人' WHERE track_title = 'å¤¢ä¸­äºº';
-- album_title: 7 distinct values, 9 rows
UPDATE wxyc_schema.flowsheet SET album_title = 'د' WHERE album_title = 'Ø¯';
UPDATE wxyc_schema.flowsheet SET album_title = '繭' WHERE album_title = 'ç¹­';
UPDATE wxyc_schema.flowsheet SET album_title = 'Atmospheres 第3' WHERE album_title = 'Atmospheres ç¬¬3';
UPDATE wxyc_schema.flowsheet SET album_title = 'Ege Bamyası' WHERE album_title = 'Ege BamyasÄ±';
UPDATE wxyc_schema.flowsheet SET album_title = 'En Kotu İyi Olur' WHERE album_title = 'En Kotu Ä°yi Olur';
UPDATE wxyc_schema.flowsheet SET album_title = 'Škoda Mluvit' WHERE album_title = 'Å koda Mluvit';
UPDATE wxyc_schema.flowsheet SET album_title = 'Ψ 847' WHERE album_title = 'Î¨ 847';
-- record_label: 3 distinct values, 3 rows
UPDATE wxyc_schema.flowsheet SET record_label = 'Galerija ŠKUC Izdaja / Dark Entries' WHERE record_label = 'Galerija Å KUC Izdaja / Dark Entries';
UPDATE wxyc_schema.flowsheet SET record_label = 'Više manje zauvijek' WHERE record_label = 'ViÅ¡e manje zauvijek';
UPDATE wxyc_schema.flowsheet SET record_label = 'Ω' WHERE record_label = 'Î©';
