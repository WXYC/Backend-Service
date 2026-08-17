/**
 * Upper bound for a Postgres int4 column. A query value outside this range
 * parses fine as a JS integer (`Number.isInteger` returns true) but blows up
 * downstream as an unhandled "value out of range for type integer" Postgres
 * error -- SQLSTATE 22003, which is not a `WxycError` and so answers a
 * generic 500 plus a Sentry capture.
 *
 * `flowsheet.controller.ts` hit this first, on `start_id`/`end_id`
 * (BS#1800). `library.controller.ts`'s `GET /library/artists/by-code`
 * (BS#2149) reuses it for `genre_id`/`code_number` rather than re-declaring
 * a second copy -- the BS#2149 review found the two had drifted apart (one
 * file's copy claimed to "reuse" a constant that was actually a duplicate).
 * Import this one wherever an int4-bound query parameter needs the same
 * guard; do not re-declare it locally.
 */
export const INT4_MAX = 2147483647;
