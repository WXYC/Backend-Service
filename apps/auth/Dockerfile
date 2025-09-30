# Build stage
FROM node:20-alpine AS builder
WORKDIR /app

# Copy workspace files
COPY package*.json ./
COPY apps/auth/package*.json ./apps/auth/
COPY packages/database/package*.json ./packages/database/

# Install dependencies
RUN npm ci --workspace=apps/auth --workspace=packages/database

# Copy source code
COPY apps/auth/ ./apps/auth/
COPY packages/database/ ./packages/database/

# Build the application
WORKDIR /app/apps/auth
RUN npm run build

# Production stage
FROM node:20-alpine AS prod
WORKDIR /app

# Copy package files
COPY package*.json ./
COPY apps/auth/package*.json ./apps/auth/
COPY packages/database/package*.json ./packages/database/

# Install production dependencies
RUN npm ci --workspace=apps/auth --workspace=packages/database --omit=dev

# Copy built application
COPY --from=builder /app/apps/auth/dist ./dist

EXPOSE 8787

CMD ["node", "dist/app.js"]
