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
COPY package* ./
RUN npm install --production
COPY --from=builder ./app/dist ./dist

EXPOSE 8080

CMD ["npm", "start"]