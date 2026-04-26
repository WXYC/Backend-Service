# Backend-Service mojibake audit (M0.1)

- Round-trippable distinct values: **33** covering **52** rows
  - Auto-apply (conf ≥ 90): 14 pairs / 30 rows
  - Manual review (70-89):  16 pairs / 18 rows
  - Ambiguous (< 70):       3 pairs / 4 rows
- Lossy distinct values:           **816** covering **1114** rows

## Per-(table, column) coverage

| table | column | distinct non-ASCII | rows non-ASCII | distinct round-trip | rows round-trip | distinct lossy | rows lossy |
|---|---|---:|---:|---:|---:|---:|---:|
| artist_crossreference | comment | 0 | 0 | 0 | 0 | 0 | 0 |
| artist_library_crossreference | comment | 0 | 0 | 0 | 0 | 0 | 0 |
| artists | alphabetical_name | 1 | 1 | 0 | 0 | 0 | 0 |
| artists | artist_name | 3 | 3 | 0 | 0 | 0 | 0 |
| bins | track_title | 0 | 0 | 0 | 0 | 0 | 0 |
| compilation_track_artist | artist_name | 0 | 0 | 0 | 0 | 0 | 0 |
| compilation_track_artist | track_title | 0 | 0 | 0 | 0 | 0 | 0 |
| flowsheet | album_title | 1278 | 5450 | 7 | 9 | 223 | 295 |
| flowsheet | artist_bio | 0 | 0 | 0 | 0 | 0 | 0 |
| flowsheet | artist_name | 1248 | 5850 | 6 | 17 | 100 | 139 |
| flowsheet | message | 0 | 0 | 0 | 0 | 0 | 0 |
| flowsheet | record_label | 234 | 1479 | 3 | 3 | 46 | 54 |
| flowsheet | track_title | 2411 | 3757 | 17 | 23 | 447 | 626 |
| genres | description | 0 | 0 | 0 | 0 | 0 | 0 |
| genres | genre_name | 0 | 0 | 0 | 0 | 0 | 0 |
| labels | label_name | 0 | 0 | 0 | 0 | 0 | 0 |
| library | album_artist | 0 | 0 | 0 | 0 | 0 | 0 |
| library | album_title | 10 | 10 | 0 | 0 | 0 | 0 |
| library | alternate_artist_name | 0 | 0 | 0 | 0 | 0 | 0 |
| library | label | 0 | 0 | 0 | 0 | 0 | 0 |
| reviews | author | 0 | 0 | 0 | 0 | 0 | 0 |
| reviews | review | 0 | 0 | 0 | 0 | 0 | 0 |
| shows | legacy_dj_name | 0 | 0 | 0 | 0 | 0 | 0 |
| shows | show_name | 12 | 17 | 0 | 0 | 0 | 0 |
| specialty_shows | description | 0 | 0 | 0 | 0 | 0 | 0 |
| specialty_shows | specialty_name | 0 | 0 | 0 | 0 | 0 | 0 |

## Top 50 round-trippable values

| rows | conf | table.column | current → proposed |
|---:|---:|---|---|
| 12 | 95 | flowsheet.artist_name | `Î¼-Ziq` → `μ-Ziq` |
| 4 | 95 | flowsheet.track_title | `Î©Î©Î©` → `ΩΩΩ` |
| 3 | 85 | flowsheet.track_title | `HelvacÄ±` → `Helvacı` |
| 2 | 50 | flowsheet.track_title | `ï½¡.ï½¥BLUSHï½¥.ï½¡` → `｡.･BLUSH･.｡` |
| 2 | 95 | flowsheet.album_title | `Ø¯` → `د` |
| 2 | 95 | flowsheet.album_title | `ç¹­` → `繭` |
| 1 | 85 | flowsheet.track_title | `YalnÄ±zlar RÄ±htÄ±mÄ±` → `Yalnızlar Rıhtımı` |
| 1 | 50 | flowsheet.track_title | `tno doÉ¹p` → `tno doɹp` |
| 1 | 95 | flowsheet.track_title | `Hidden Power (Phase Î´)` → `Hidden Power (Phase δ)` |
| 1 | 85 | flowsheet.track_title | `JoÅ¡ Jedna Crta` → `Još Jedna Crta` |
| 1 | 85 | flowsheet.track_title | `Å¡to me vikas, Å¡efijo` → `što me vikas, šefijo` |
| 1 | 95 | flowsheet.track_title | `400ç±³` → `400米` |
| 1 | 50 | flowsheet.track_title | `DesgracaÌ§da` → `Desgraca̧da` |
| 1 | 95 | flowsheet.track_title | `Ð´Ð²Ð° TWO` → `два TWO` |
| 1 | 85 | flowsheet.track_title | `PoznajeÅ¡ Li Moje Pravo Lice` → `Poznaješ Li Moje Pravo Lice` |
| 1 | 85 | flowsheet.track_title | `GadÅ¼et elektroniczny` → `Gadżet elektroniczny` |
| 1 | 85 | flowsheet.track_title | `DaÅ¡a` → `Daša` |
| 1 | 95 | flowsheet.track_title | `å¤¢ä¸­äºº` → `夢中人` |
| 1 | 85 | flowsheet.track_title | `78 Yilinin En Uzun DakikasÄ±` → `78 Yilinin En Uzun Dakikası` |
| 1 | 85 | flowsheet.track_title | `Å eva` → `Ševa` |
| 1 | 85 | flowsheet.album_title | `Å koda Mluvit` → `Škoda Mluvit` |
| 1 | 95 | flowsheet.album_title | `Atmospheres ç¬¬3` → `Atmospheres 第3` |
| 1 | 95 | flowsheet.album_title | `Î¨ 847` → `Ψ 847` |
| 1 | 85 | flowsheet.album_title | `Ege BamyasÄ±` → `Ege Bamyası` |
| 1 | 85 | flowsheet.album_title | `En Kotu Ä°yi Olur` → `En Kotu İyi Olur` |
| 1 | 95 | flowsheet.artist_name | `Î¼-ziq` → `μ-ziq` |
| 1 | 85 | flowsheet.artist_name | `Mustafah 'Abd Al'-AzÄ«z` → `Mustafah 'Abd Al'-Azīz` |
| 1 | 85 | flowsheet.artist_name | `LuboÅ¡ FiÅ¡er` → `Luboš Fišer` |
| 1 | 95 | flowsheet.artist_name | `GrOunå£« + Kabamix` → `GrOun士 + Kabamix` |
| 1 | 95 | flowsheet.artist_name | `Î£tella, Las Palabras` → `Σtella, Las Palabras` |
| 1 | 85 | flowsheet.record_label | `ViÅ¡e manje zauvijek` → `Više manje zauvijek` |
| 1 | 85 | flowsheet.record_label | `Galerija Å KUC Izdaja / Dark Entries` → `Galerija ŠKUC Izdaja / Dark Entries` |
| 1 | 95 | flowsheet.record_label | `Î©` → `Ω` |

## Top 25 lossy values (require LML or external recovery)

| rows | table.column | current |
|---:|---|---|
| 39 | flowsheet.track_title | `La Musique Du CÅ?ur` |
| 33 | flowsheet.album_title | `f#a#â??` |
| 31 | flowsheet.track_title | `Do It 4 U (feat. Dâ??WN)` |
| 12 | flowsheet.track_title | `Renée (Who's Driving Your Car?)` |
| 12 | flowsheet.artist_name | `Astrid Ã?ster Mortenson` |
| 11 | flowsheet.track_title | `Wsyzstkie Wschody StoÅ?ca` |
| 10 | flowsheet.artist_name | `Joint Dâ?` |
| 9 | flowsheet.track_title | `Adem OÄ?lu KÄ±zgÄ±n FÄ±rÄ±n Havva KÄ±zÄ± Mercimek` |
| 8 | flowsheet.track_title | `Te Odio (¿Te Amo?)` |
| 8 | flowsheet.track_title | `Catastrophe â??` |
| 8 | flowsheet.track_title | `ObsesioÌ?n RomaÌ?ntica` |
| 7 | flowsheet.track_title | `á??á?©á?«á??á?¡ á??á?¡á?·á??á?³á?« á??á?µá??á?³á?· á??á?©á?¯á??á?µ` |
| 7 | flowsheet.track_title | `Tik - Tak Å? Aurorina Seleve` |
| 7 | flowsheet.album_title | `æ?°ã??ã??æ?¥ã?®èª?ç?? (Birth of a New Day)` |
| 5 | flowsheet.album_title | `For Those Of You Who Have Never (And Also Those Who Have) â??` |
| 4 | flowsheet.track_title | `Widen Spytâ?? (Vienna Is Sleeping)` |
| 4 | flowsheet.album_title | `La Musique Ã?lectronique Du Niger` |
| 4 | flowsheet.album_title | `Pacific Breeze: Japanese City Pop, AOR, and Boogie 1976â??1986` |
| 4 | flowsheet.artist_name | `SIW SJÃ?BERG` |
| 3 | flowsheet.track_title | `Mr. Grammarticalogy â?? Lisationalism is the Boss` |
| 3 | flowsheet.track_title | `Plus Jamais Ã?a` |
| 3 | flowsheet.track_title | `Iâ??m Not Sayinâ??` |
| 3 | flowsheet.track_title | `Ã?ltima instancia` |
| 3 | flowsheet.track_title | `ì?¬ë¦?: ëª¨í?¸í?¨ ì??ì?? ë?? / 2ì??ì?¥ / ë??ì??ì¤? ë??ê°? ë??ë©´ ë??ì??ì£¼ê¸° (C` |
| 3 | flowsheet.track_title | `Good Feeling (Mr Gâ??s Turn On Dub)` |
