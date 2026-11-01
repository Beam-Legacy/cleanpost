# Worker image (sync jobs) for preview (Railway) and later environments. Build context: repository root.
FROM node:22-bookworm-slim
ENV PNPM_HOME=/pnpm PATH=/pnpm:$PATH CI=1 COREPACK_ENABLE_DOWNLOAD_PROMPT=0
RUN corepack enable && corepack prepare pnpm@10.28.0 --activate
WORKDIR /repo
COPY . .
RUN pnpm install --frozen-lockfile --filter @cleanpost/worker...
ENV NODE_ENV=production
EXPOSE 4020
CMD ["pnpm", "--filter", "@cleanpost/worker", "start"]
