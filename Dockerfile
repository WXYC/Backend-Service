#Build stage
FROM node:20-alpine AS builder
WORKDIR /app
COPY . .
RUN npm install && \
    npm run clean && \
    npm run build

#Production stage
FROM node:20-alpine AS prod
WORKDIR /app
COPY apps/backend/package*.json ./
RUN npm install --production
COPY --from=builder /app/apps/backend/dist ./dist
COPY --from=builder /app/packages/database/dist ./node_modules/@wxyc/database/dist
COPY --from=builder /app/packages/shared/dist ./node_modules/@wxyc/shared/dist
COPY --from=builder /app/packages/auth-middleware/dist ./node_modules/@wxyc/auth-middleware/dist

EXPOSE 8080

CMD ["npm", "start"]