FROM public.ecr.aws/lambda/nodejs:24 AS build

ARG PANDOC_VERSION=3.6.4
ARG PANDOC_SHA256_AMD64=5def6e1ff535e397becce292ee97767a947306150b9fb1488003b67ac3417c5e
ARG PANDOC_SHA256_ARM64=ad5cf63fe0420388d9ec513f02d03e061477b786d11a328164dce8ad7387b8bd
ARG TARGETARCH

WORKDIR /workspace
RUN dnf install -y gzip tar \
    && dnf clean all \
    && corepack enable

RUN case "${TARGETARCH}" in \
      amd64) pandoc_arch="amd64"; pandoc_sha="${PANDOC_SHA256_AMD64}" ;; \
      arm64) pandoc_arch="arm64"; pandoc_sha="${PANDOC_SHA256_ARM64}" ;; \
      *) echo "Unsupported architecture: ${TARGETARCH}" >&2; exit 1 ;; \
    esac \
    && mkdir -p /opt/pandoc \
    && curl --fail --location --silent --show-error \
      "https://github.com/jgm/pandoc/releases/download/${PANDOC_VERSION}/pandoc-${PANDOC_VERSION}-linux-${pandoc_arch}.tar.gz" \
      --output /tmp/pandoc.tar.gz \
    && echo "${pandoc_sha}  /tmp/pandoc.tar.gz" | sha256sum --check --strict \
    && tar --extract --gzip --strip-components=1 --file /tmp/pandoc.tar.gz --directory /opt/pandoc \
    && rm /tmp/pandoc.tar.gz \
    && /opt/pandoc/bin/pandoc --version

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY packages/ingestion/package.json packages/ingestion/package.json
RUN pnpm install --frozen-lockfile --filter @smithy-mcp/ingestion...

COPY packages/ingestion packages/ingestion
RUN pnpm --filter @smithy-mcp/ingestion run build \
    && pnpm --filter @smithy-mcp/ingestion deploy --prod --legacy /asset

FROM public.ecr.aws/lambda/nodejs:24 AS runtime

RUN dnf install -y git \
    && dnf clean all

COPY --from=build /opt/pandoc/bin/pandoc /usr/local/bin/pandoc
COPY --from=build /asset/dist/ ${LAMBDA_TASK_ROOT}/
COPY --from=build /asset/node_modules/ ${LAMBDA_TASK_ROOT}/node_modules/
COPY --from=build /asset/package.json ${LAMBDA_TASK_ROOT}/package.json

CMD ["handler.handler"]
