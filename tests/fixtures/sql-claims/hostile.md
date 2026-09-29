# Hostile sql-claim fixture

Every line in this block must be rejected by the lexer and never executed. `tests/unit/utils/sql-claims.test.ts` parses it; nothing evaluates it.

```sql-claim
1; DROP TABLE x  ->  1
(select 1 from library)  ->  1
pg_sleep(10)  ->  x
to_tsquery('simple', 'a'))  ->  'a'
to_tsquery(/* x */ 'simple', 'a')  ->  'a'
lo_create(0)  ->  1
```
