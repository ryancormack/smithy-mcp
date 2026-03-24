FROM node:20-slim AS builder

WORKDIR /build
COPY package.json ./
RUN npm install
COPY src/ ./src/
COPY tsconfig.json ./
RUN npx esbuild src/handler.ts --bundle --platform=node --target=node20 --outfile=handler.js --external:@aws-sdk/*

FROM public.ecr.aws/lambda/nodejs:20

# Install git and pandoc
RUN dnf install -y git pandoc && dnf clean all

COPY --from=builder /build/handler.js ${LAMBDA_TASK_ROOT}/

CMD ["handler.handler"]
