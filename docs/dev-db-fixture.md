# Dev DB fixture

`npm run db:start` seeds the dev DB from two files, in order:

1. `dev_env/seed_db.sql` — auth fixtures, test users, genres/formats with fixed IDs — identical to CI.
2. `dev_env/seed-clone.sql` — a ~14 MB `pg_dump` snapshot of prod's `artists / library / rotation / format / genre_artist_crossreference`, taken via the staging postgres clone. TRUNCATEs the small fixtures from the first file in the same transaction before loading.

The clone gives realistic data for UI/feature work; CI keeps running against the small seed and the fixed IDs they assume. The dev/CI distinction is gated explicitly via `LOAD_CLONE_FIXTURE=true` set on the dev-profile `db-init` service in `docker-compose.yml` (BS#951): CI's bare `node dev_env/init-db.mjs` invocation skips the clone regardless of whether the .sql file exists in the checkout.

To refresh the clone, follow the recipe in the comment at the top of `dev_env/seed-clone.sql`.

## Shape fixture sequence pins are monotonic (BS#1728)

`tests/setup/globalSetup.js` loads `tests/fixtures/shape.sql` (the #701 constraint-shape fixture) after every integration run's migrations/seed, whether or not the clone loaded. That fixture advances its sequences (`labels_id_seq`, `artists_id_seq`, `library_id_seq`, `rotation_id_seq`, `shows_id_seq`, `flowsheet_id_seq`, `compilation_track_artist_id_seq`) past its own 7000-range fixture rows so later serial inserts don't collide. Each `setval(...)` uses `GREATEST(<fixture-floor>, (SELECT last_value FROM <seq>))` rather than a bare fixed value — against a clean CI database (no clone) this still establishes the fixture's floor, but against the dev-profile clone (whose sequences are already walked up near their real prod ids, e.g. `library_id_seq` past 70,000) it never rewinds the sequence below `MAX(id)`. A bare fixed `setval` would rewind it, and every subsequent serial insert in `test:integration` would collide with an existing clone row (`duplicate key value violates unique constraint`). If you add a new sequence-bearing table to the fixture, pin it the same way.

## `npm run dev` predev hook

`npm run dev` automatically rebuilds `@wxyc/database` + `@wxyc/authentication` first via the `predev` lifecycle hook (BS#968). Without this, a fresh clone or a pull that touches `shared/database/src/schema.ts` would serve a stale schema export to the running backend — typically surfacing as a `TypeError: Cannot convert undefined or null to object` deep inside `drizzle-orm/utils.js` with no column name to chase. `apps/backend`'s own `tsup --watch` already rebuilds its own sources, but it doesn't follow workspace dep dists; `predev` covers that gap.

## Stopping the database

Stop the database with `npm run db:stop` (this runs `docker compose down -v` — the `-v` drops the `pg-data` named volume, so the dev DB is recreated from scratch on the next `db:start`).
