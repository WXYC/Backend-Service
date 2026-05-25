# Dev DB fixture

`npm run db:start` seeds the dev DB from two files, in order:

1. `dev_env/seed_db.sql` — auth fixtures, test users, genres/formats with fixed IDs — identical to CI.
2. `dev_env/seed-clone.sql` — a ~14 MB `pg_dump` snapshot of prod's `artists / library / rotation / format / genre_artist_crossreference`, taken via the staging postgres clone. TRUNCATEs the small fixtures from the first file in the same transaction before loading.

The clone gives realistic data for UI/feature work; CI keeps running against the small seed and the fixed IDs they assume. The dev/CI distinction is gated explicitly via `LOAD_CLONE_FIXTURE=true` set on the dev-profile `db-init` service in `docker-compose.yml` (BS#951): CI's bare `node dev_env/init-db.mjs` invocation skips the clone regardless of whether the .sql file exists in the checkout.

To refresh the clone, follow the recipe in the comment at the top of `dev_env/seed-clone.sql`.

## `npm run dev` predev hook

`npm run dev` automatically rebuilds `@wxyc/database` + `@wxyc/authentication` first via the `predev` lifecycle hook (BS#968). Without this, a fresh clone or a pull that touches `shared/database/src/schema.ts` would serve a stale schema export to the running backend — typically surfacing as a `TypeError: Cannot convert undefined or null to object` deep inside `drizzle-orm/utils.js` with no column name to chase. `apps/backend`'s own `tsup --watch` already rebuilds its own sources, but it doesn't follow workspace dep dists; `predev` covers that gap.

## Stopping the database

Stop the database with `npm run db:stop` (this runs `docker compose down -v` — the `-v` drops the `pg-data` named volume, so the dev DB is recreated from scratch on the next `db:start`).
