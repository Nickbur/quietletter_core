# ── build stage ──────────────────────────────────────────────────────────────
FROM node:24-bookworm-slim AS build
WORKDIR /app

# Install all dependencies (incl. dev) for the TypeScript build.
COPY package.json package-lock.json* ./
RUN npm install

# Compile to ./dist (NodeNext ESM, .js specifiers; the tests next to the code stay out). Compile only:
# `npm run build` is the full quality gate (Prettier, ESLint, type-check incl. tests, tests) and runs before a push.
COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN npx tsc -p tsconfig.build.json

# ── runtime stage ────────────────────────────────────────────────────────────
FROM node:24-bookworm-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production

# Production dependencies only (the compiled drizzle-orm migrator applies the
# generated SQL at boot — drizzle-kit / tsx / typescript are not needed here).
COPY package.json package-lock.json* ./
RUN npm install --omit=dev && npm cache clean --force

# Compiled app + the generated migrations the boot step applies.
COPY --from=build /app/dist ./dist
COPY drizzle ./drizzle

EXPOSE 8080

# Apply migrations, then start the server.
CMD ["sh", "-c", "node dist/db/migrate.js && node dist/server.js"]
