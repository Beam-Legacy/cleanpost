# Payer simulator image: local and preview only (the server refuses to start in staging or production).
FROM node:22-bookworm-slim
ENV PNPM_HOME=/pnpm PATH=/pnpm:$PATH CI=1 COREPACK_ENABLE_DOWNLOAD_PROMPT=0
RUN corepack enable && corepack prepare pnpm@10.28.0 --activate
WORKDIR /repo
COPY . .
RUN pnpm install --frozen-lockfile --filter @cleanpost/payer-sim...
ENV NODE_ENV=production
EXPOSE 4030
CMD ["pnpm", "--filter", "@cleanpost/payer-sim", "start"]
