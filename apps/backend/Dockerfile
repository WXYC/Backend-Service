# Build stage
FROM node:20.18.0-alpine AS builder
WORKDIR /app

# Copy workspace files
COPY package*.json ./
COPY apps/backend/package*.json ./apps/backend/
COPY packages/database/package*.json ./packages/database/
COPY packages/shared/package*.json ./packages/shared/
COPY packages/auth-middleware/package*.json ./packages/auth-middleware/

# Install dependencies
RUN npm ci --workspace=apps/backend --workspace=packages/database --workspace=packages/shared --workspace=packages/auth-middleware

# Copy source code
COPY apps/backend/ ./apps/backend/
COPY packages/database/ ./packages/database/
COPY packages/shared/ ./packages/shared/
COPY packages/auth-middleware/ ./packages/auth-middleware/

# Build the application
WORKDIR /app/apps/backend
RUN npm run build

# Production stage
FROM node:20.18.0-alpine AS prod
WORKDIR /app

# Copy package files
COPY package*.json ./
COPY apps/backend/package*.json ./apps/backend/
COPY packages/database/package*.json ./packages/database/
COPY packages/shared/package*.json ./packages/shared/
COPY packages/auth-middleware/package*.json ./packages/auth-middleware/

# Install production dependencies
RUN npm ci --workspace=apps/backend --workspace=packages/database --workspace=packages/shared --workspace=packages/auth-middleware --omit=dev

# Copy built application
COPY --from=builder /app/apps/backend/dist ./dist

EXPOSE 8080

CMD ["node", "dist/app.js"]
