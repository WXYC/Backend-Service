# Migration Rollbacks

This directory contains rollback scripts for database migrations. These are emergency procedures for reverting migrations in production.

## When to Use Rollbacks

Rollbacks should only be used in emergency situations:

- A migration causes unexpected application errors
- Performance degradation after migration
- Data integrity issues discovered post-migration

## Before Rolling Back

1. **Assess the impact** - Understand what the rollback will do
2. **Check for data loss** - Some rollbacks (dropping columns/tables) lose data permanently
3. **Coordinate with team** - Notify all stakeholders before executing
4. **Create a backup** - Always backup before rollback:
   ```bash
   pg_dump -h $DB_HOST -U $DB_USERNAME -d $DB_NAME -F c -f backup_$(date +%Y%m%d_%H%M%S).dump
   ```

## Executing a Rollback

1. Connect to the production database
2. Review the rollback file carefully
3. Execute statements one at a time for complex rollbacks
4. Verify application functionality after each major change

```bash
# Connect to production database
psql -h $DB_HOST -U $DB_USERNAME -d $DB_NAME

# Execute rollback (example)
\i rollbacks/0027_add-performance-indexes.rollback.sql
```

## Rollback File Format

Each rollback file follows this format:

```sql
-- Rollback: NNNN_migration_name
-- Original migration: NNNN_migration_name.sql
-- Risk level: LOW|MEDIUM|HIGH
-- Data loss: YES|NO
-- Duration estimate: <time>
--
-- Description:
-- Brief description of what this rollback does
--
-- Pre-rollback checklist:
-- [ ] Backup created
-- [ ] Team notified
-- [ ] Maintenance window scheduled (if needed)

-- Rollback statements here
```

## Risk Levels

| Level | Description | Examples |
|-------|-------------|----------|
| LOW | Non-destructive, fast | Dropping indexes |
| MEDIUM | May affect performance during execution | Dropping constraints |
| HIGH | Data loss or long-running | Dropping tables/columns |

## Generating Rollbacks

Use the rollback generator script:

```bash
# Generate rollback for a specific migration
npm run rollback:generate -- 0027_add-performance-indexes.sql

# Generate rollbacks for all migrations
npm run rollback:generate -- --all
```

## Important Notes

- Rollback files are generated as templates - always review before executing
- Some operations cannot be fully rolled back (e.g., data transformations)
- Drizzle's migration journal tracks applied migrations - manual intervention may be needed
- Always test rollbacks in a non-production environment first
