# Database Replication (Local Sync)

PostgreSQL logical replication keeps a local database clone in sync with production RDS in real time. Changes stream continuously with guaranteed delivery — the replication slot retains WAL even if the subscriber is offline.

## Setup

```bash
# One-time: enable rds.logical_replication=1 in the RDS parameter group (requires reboot)
# Then:
./scripts/sync/setup-replication.sh    # Opens tunnel, creates publication + subscription
```

## Daily use

```bash
./scripts/sync/tunnel.sh               # Open tunnel (must stay open for replication)
./scripts/sync/tunnel.sh --kill        # Close tunnel
./scripts/sync/teardown-replication.sh # Remove subscription + close tunnel
```

## Monitor replication status

```sql
-- On local database:
SELECT * FROM pg_stat_subscription;     -- srsubstate = 'r' means ready
SELECT * FROM pg_subscription;          -- shows connection info
```

## Prerequisites

- RDS parameter group: `rds.logical_replication = 1` (one-time, requires instance reboot)
- `rds_replication` role granted to the RDS user
- SSH access via `ssh wxyc-ec2`
- Local PostgreSQL running (`npm run db:start`)
- `psql` installed (`brew install libpq`)
