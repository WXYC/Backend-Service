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

`npm run db:stop` runs `docker compose down` and leaves the `pg-data` named volume in place, so the next `db:start` reattaches to the same database. `npm run db:reset` is the destructive form (`down -v`): it drops the volume, and the next `db:start` rebuilds the database from the migrations and both seed files. Reach for `db:reset` when you want a clean fixture — after a migration rewrite, or when the local DB has drifted — and for nothing else.

The split matters because these commands act on a project shared by every checkout of this repo (see below): a stop that also dropped the volume was a stop that could delete the seeded database another worktree was working against.

## Which stack these commands act on

`dev_env/docker-compose.yml` declares `name: wxyc-backend`. That name is the Compose project, and it prefixes every container, network, and volume the file creates: `wxyc-backend-db-1`, `wxyc-backend_pg-data`, and so on. Without the declaration Compose derives the project from the compose file's own directory — `dev_env` for every clone and every worktree of this repo, so all of them addressed one project without saying so.

Declaring it does not by itself give each worktree its own database; it makes the sharing explicit and stops a stray `down` from being a function of which directory you happened to be standing in. A worktree that genuinely needs an independent stack sets `COMPOSE_PROJECT_NAME` in its own `.env`, plus distinct host ports (`DB_PORT`, `CI_DB_PORT`, `E2E_DB_PORT`, `ETL_PG_PORT`, `ETL_MYSQL_PORT`) — containers are namespaced by project, but the host ports they publish are not, so two stacks on the same ports still collide.

No service pins a `container_name`. Container names are global to the Docker daemon rather than scoped to a Compose project, so a pinned name makes two projects mutually exclusive — the second to start fails with `Conflict. The container name "/..." is already in use`. Address a container through `docker compose <subcommand> <service>`, which resolves it within the project, rather than by a generated name.
