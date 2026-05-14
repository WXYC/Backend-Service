# Backend-Service U+FFFD-form mojibake audit (#863, Phase 1)

- Distinct lossy values: **65**
- Rows affected:         **113**

Recovery approach (Phase 2): query LML for canonical candidates per distinct value; threshold confidence >= 0.80 per the V015/V016 lml-fuzzy convention. Human review of the candidates CSV gates any migration. No UPDATE / DELETE generated at this phase.

## Per-(table, column) coverage

| table | column | distinct lossy | rows lossy |
|---|---|---:|---:|
| flowsheet | album_title | 9 | 21 |
| flowsheet | artist_name | 7 | 9 |
| flowsheet | record_label | 2 | 9 |
| flowsheet | track_title | 21 | 36 |
| library | album_title | 8 | 8 |
| library | artist_name | 3 | 15 |
| library | label | 0 | 0 |
| rotation | album_title | 5 | 5 |
| rotation | artist_name | 8 | 8 |
| rotation | record_label | 2 | 2 |

## Top 50 lossy values by row_count

| rows | table.column | lossy_value |
|---:|---|---|
| 10 | library.artist_name | `�-Ziq [mu-Ziq]` |
| 9 | flowsheet.album_title | `A Sua Divers�o / N�o Tem Nada N�o` |
| 8 | flowsheet.record_label | `Infin� Editions` |
| 6 | flowsheet.track_title | `A Sua Divers�o` |
| 4 | library.artist_name | `Beyonc�` |
| 4 | flowsheet.album_title | `Music from the Caucasus � The Archive of ORED Recordings, 2013�2023` |
| 3 | flowsheet.track_title | `Iris (N�dia Remix)` |
| 3 | flowsheet.track_title | `Mallku Diabl�n` |
| 3 | flowsheet.track_title | `N�o Tem Nada N�o` |
| 2 | flowsheet.artist_name | `Csillagrabl�k` |
| 2 | flowsheet.artist_name | `Sonido Due�ez` |
| 2 | flowsheet.track_title | `Arh�` |
| 2 | flowsheet.track_title | `J'ai Oubli�` |
| 2 | flowsheet.track_title | `Uno Es �rbol` |
| 2 | flowsheet.track_title | `blade bird - Nick Le�n broward mix` |
| 2 | flowsheet.album_title | `Rem�nytelen` |
| 1 | rotation.artist_name | `Acc�sed` |
| 1 | rotation.artist_name | `Amare Tour�` |
| 1 | rotation.artist_name | `Civilistj�vel! & Mayssa Jallad` |
| 1 | rotation.artist_name | `Csillagrabl�k` |
| 1 | rotation.artist_name | `Kai Alc�` |
| 1 | rotation.artist_name | `N�dia & Valentina` |
| 1 | rotation.artist_name | `Sonido Due�ez` |
| 1 | rotation.artist_name | `}�{ (Louise Boghossian and Romain Vasset)` |
| 1 | rotation.album_title | `A Sua Divers�o / N�o Tem Nada N�o` |
| 1 | rotation.album_title | `Amare Tour� 1973-1980` |
| 1 | rotation.album_title | `Midnight Zone (Original Soundtrack to the Film by Julian Charri�re)` |
| 1 | rotation.album_title | `Rem�nytelen` |
| 1 | rotation.album_title | `���` |
| 1 | rotation.record_label | `GER�USCHMANUFAKTUR` |
| 1 | rotation.record_label | `Infin� Editions` |
| 1 | library.artist_name | `Damian Nisenson / Jean F�lix Mailloux / Pierre Tanguay` |
| 1 | library.album_title | `Ballet M�canique` |
| 1 | library.album_title | `Battles Ol�` |
| 1 | library.album_title | `Chansons pour le corps; Et si tout enti�re maintenant` |
| 1 | library.album_title | `HACE/26,250'/11� 22.4'N 142� 35.5'E` |
| 1 | library.album_title | `La B�te` |
| 1 | library.album_title | `La For�t` |
| 1 | library.album_title | `Mortelle Randonn�e (Extraits de la Bande Originale du Film)` |
| 1 | library.album_title | `Rock en Espa�ol Vol. One` |
| 1 | flowsheet.artist_name | `Ana Mar�a Vahos` |
| 1 | flowsheet.artist_name | `Eydie Gorm�` |
| 1 | flowsheet.artist_name | `Mehmet G�reli` |
| 1 | flowsheet.artist_name | `U?ur Y�cel` |
| 1 | flowsheet.artist_name | `p�r-no` |
| 1 | flowsheet.track_title | `Bliws Afon T�f` |
| 1 | flowsheet.track_title | `COLORATURA, 24� 3' 27.0" N, 123� 47' 7.5" E` |
| 1 | flowsheet.track_title | `Ch'uwancha�a ~El Golpe Final~` |
| 1 | flowsheet.track_title | `Convocaci�n "Banger/Diffusion"` |
| 1 | flowsheet.track_title | `Dod�i` |
