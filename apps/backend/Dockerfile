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

# Build all packages first
WORKDIR /app/packages/database
RUN npm run build
WORKDIR /app/packages/shared
RUN npm run build
WORKDIR /app/packages/auth-middleware
RUN npm run build

# Build the backend application
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

# Copy built application and packages
COPY --from=builder /app/apps/backend/dist ./dist
COPY --from=builder /app/packages/database/dist ./node_modules/@wxyc/database/dist
COPY --from=builder /app/packages/database/package.json ./node_modules/@wxyc/database/
COPY --from=builder /app/packages/shared/dist ./node_modules/@wxyc/shared/dist
COPY --from=builder /app/packages/shared/package.json ./node_modules/@wxyc/shared/
COPY --from=builder /app/packages/auth-middleware/dist ./node_modules/@wxyc/auth-middleware/dist
COPY --from=builder /app/packages/auth-middleware/package.json ./node_modules/@wxyc/auth-middleware/

EXPOSE 8080

CMD ["node", "dist/app.js"]
