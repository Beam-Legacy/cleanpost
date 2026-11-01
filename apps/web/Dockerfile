# Web app image for preview (Railway) and later environments. Build context: repository root.
FROM node:22-bookworm-slim AS base
ENV PNPM_HOME=/pnpm PATH=/pnpm:$PATH NEXT_TELEMETRY_DISABLED=1 CI=1
RUN corepack enable
WORKDIR /repo

FROM base AS build
COPY . .
RUN pnpm install --frozen-lockfile
RUN pnpm --filter @cleanpost/web build

FROM base AS run
ENV NODE_ENV=production
COPY --from=build /repo /repo
EXPOSE 3000
# Railway runs `pnpm release:preview` before each deploy: app database login, migrations, synthetic seed.
CMD ["pnpm", "--filter", "@cleanpost/web", "start"]
