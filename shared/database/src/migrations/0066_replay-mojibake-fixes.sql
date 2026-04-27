-- 0066: Replay 0064_propagate-v012-mojibake's mojibake fixes.
--
-- 0064's `when` was lowered (commit 7f35fc39) below the prod cursor
-- (1779424000000), which made drizzle silently skip it. Bumping 0064's
-- `when` back up would put it out of order with 0065 in the journal and
-- trip the validator. Replaying as a new file at when > prod cursor is
-- the same shape we used for 0054 -> 0065 in PR #551.
--
-- 0064's body was already idempotent — every UPDATE is keyed on the
-- corrupted value, so a re-run leaves the corrected forms alone. This
-- file is a verbatim copy from 0064 below the header. Verified locally.


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
