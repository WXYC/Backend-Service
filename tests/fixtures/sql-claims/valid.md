# Valid sql-claim fixture

```sql-claim
to_tsquery('simple', $$'-3d':*$$)  ->  '-3':* <-> 'd':*   -- a trailing comment
to_tsvector('simple', 'Minus 5 -3d World') @@ to_tsquery('simple', $$'3d':*$$)  ->  false
```

A plain `sql` block is not a claim block and is ignored, even if it looks like one:

```sql
SELECT 1; -- ->  anything
```
