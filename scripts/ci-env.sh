#!/bin/bash
# Start CI environment with Docker Compose
# Usage: ./scripts/ci-env.sh

set -e

echo "🔨 Building Docker images..."
npm run ci:build

echo "🚀 Starting CI services..."
COMPOSE="docker compose -f dev_env/docker-compose.yml --env-file .env --profile ci"
$COMPOSE up -d ci-db
$COMPOSE up ci-db-init
$COMPOSE up -d auth backend

echo "✅ CI environment ready"
