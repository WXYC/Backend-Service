BASEDIR=$(dirname "$0")
source $BASEDIR/../.env

DB_HOST="localhost"
DB_PORT=${DB_PORT:-5432}

if [ "$USE_CI" = true ] ; then
    DB_PORT=${CI_DB_PORT:-5433}
fi

PGPASSWORD=$DB_PASSWORD psql -q -h $DB_HOST -p $DB_PORT -U $DB_USERNAME -d 'wxyc_db' < $BASEDIR/install_extensions.sql

#init db schema
DB_PORT=$DB_PORT DB_HOST=$DB_HOST npm run drizzle:migrate

#seed db
PGPASSWORD=$DB_PASSWORD psql --quiet -h $DB_HOST -p $DB_PORT -U $DB_USERNAME -d 'wxyc_db' < $BASEDIR/seed_db.sql

echo "DB setup complete!"
