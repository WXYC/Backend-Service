@echo off
set PGPASSWORD=RadioIsEpic$1100
psql -h localhost -p 5433 -U wxyc_admin -d wxyc_db -f dev_env/install_extensions.sql
set DB_PORT=5433
set DB_HOST=localhost
npm run drizzle:migrate
psql -h localhost -p 5433 -U wxyc_admin -d wxyc_db -f dev_env/seed_db.sql
echo DB setup complete!
