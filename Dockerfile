# ---- build stage ----
FROM node:20-slim AS build
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm install
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

# ---- runtime stage ----
FROM node:20-slim AS runtime
ENV NODE_ENV=production
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm install --omit=dev && npm cache clean --force
COPY --from=build /app/dist ./dist
# Migrations are read at runtime by dist/db/migrate.js
COPY --from=build /app/src/db/migrations ./dist/db/migrations
EXPOSE 3000
# Run migrations, then start the web (which also runs the worker by default).
CMD ["sh", "-c", "node dist/db/migrate.js && node dist/index.js"]
