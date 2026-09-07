FROM public.ecr.aws/docker/library/node:22-bookworm-slim AS build

WORKDIR /workspace
RUN corepack enable

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY packages/functions/package.json packages/functions/package.json
COPY packages/cdk/package.json packages/cdk/package.json
RUN pnpm install --frozen-lockfile --filter @smithy-mcp/functions... --filter @smithy-mcp/cdk...

COPY packages/functions packages/functions
RUN pnpm --filter @smithy-mcp/cdk exec esbuild \
      ../functions/src/mcp-server/index.ts \
      --bundle \
      --platform=node \
      --target=node22 \
      --format=esm \
      --minify \
      --sourcemap \
      --banner:js="import { createRequire } from 'module';const require = createRequire(import.meta.url);" \
      --outfile=/asset/index.mjs

FROM public.ecr.aws/awsguru/aws-lambda-adapter:1.1.0 AS adapter
FROM public.ecr.aws/docker/library/node:22-bookworm-slim AS runtime

ENV NODE_ENV=production \
    PORT=8080 \
    AWS_LWA_PORT=8080 \
    AWS_LWA_READINESS_CHECK_PATH=/ \
    SMITHY_MCP_SERVER_AUTOSTART=true

WORKDIR /var/task
COPY --from=adapter /lambda-adapter /opt/extensions/lambda-adapter
COPY --from=build /asset/index.mjs /asset/index.mjs.map ./

USER node
CMD ["node", "index.mjs"]
