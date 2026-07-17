# Smithy MCP Server

A production-oriented, serverless [Model Context Protocol (MCP)](https://modelcontextprotocol.io/) server for the Smithy 2.0 documentation. It retrieves semantic matches through Amazon Bedrock Knowledge Bases and exposes the published Markdown directly for browsing and full-document reads.

The public, user-facing endpoint is `https://<environment-domain>/mcp`. The generated Lambda Function URL is an AWS IAM-authenticated CloudFront origin and is intentionally neither public nor emitted as a stack output. This repository defines the infrastructure and its automated checks; it does **not** claim that a real AWS deployment has been exercised.

## MCP tools

| Tool | Input | Behavior |
| --- | --- | --- |
| `search_smithy_docs` | `query`: 1–2,000 characters; `max_results`: optional integer 1–10, default 5 | Uses Bedrock `Retrieve` and returns scored documentation chunks. |
| `read_smithy_doc` | `file_path`: relative path, up to 1,024 characters | Reads a file below `smithy-docs/`; traversal is rejected and output is bounded. |
| `list_smithy_topics` | none | Lists deterministic sorted paths below `smithy-docs/`. The response reports included versus discovered counts, includes only complete paths within 256 KiB, and notes both output truncation and the 5,000-key discovery cap when applicable. |

The server uses stateless MCP Streamable HTTP. Configure an MCP client with:

```json
{
  "mcpServers": {
    "smithy-docs": {
      "url": "https://mcp.example.invalid/mcp",
      "transport": "http"
    }
  }
}
```

## Architecture and request flow

See the editable [Mermaid architecture source](architecture.mmd). The deployment consists of three stage-qualified CDK stacks: DNS, knowledge base/ingestion, and MCP server.

An MCP request follows this exact path:

1. Route 53 `A` and `AAAA` aliases resolve the environment domain to CloudFront. ACM supplies the TLS certificate in `us-east-1`; WAF applies a per-IP five-minute rate limit and rejects request bodies over 64 KiB.
2. CloudFront's exact `/mcp` behavior redirects HTTP to HTTPS, disables caching, and forwards viewer values except the original `Host`. Other paths use a private static S3 origin.
3. On the `/mcp` origin request, Lambda@Edge receives the body and adds its SHA-256 as `X-Amz-Content-Sha256`.
4. CloudFront Origin Access Control (OAC) signs the origin request. The origin is an `AWS_IAM` Lambda Function URL, and its resource policy allows invocation only from this account's CloudFront distribution. Ordinary MCP clients do not need AWS credentials.
5. CloudFront pins `X-Mcp-Forwarded-Host` to the configured public domain. The application replaces the Lambda URL host with that value before its host/origin allowlist check, then handles `POST /mcp`.
6. The MCP Lambda runs in `us-east-1` but uses `AWS_RESOURCE_REGION` to read live Markdown from S3 and call `bedrock:Retrieve` against the workload-region knowledge base.

There is no built-in end-user authentication beyond the public CloudFront boundary. OAC protects the private **origin**, not viewers. WAF, request/output limits, exact host/origin checks, reserved concurrency, and least-privilege workload IAM provide abuse containment, but add viewer authentication at the edge if the service must be private.

## Regions and environment isolation

`staging` and `production` use names prefixed with `smithy-mcp-<environment>` and may use different AWS accounts, domains, workload regions, limits, and budgets. Production stacks enable CloudFormation termination protection. Separate accounts are recommended for a stronger boundary.

The workload region contains the documentation bucket, S3 Vectors bucket/index, Bedrock knowledge base/data source, ingestion Lambda, EventBridge schedule, DLQ, and related alarms. The edge region is always `us-east-1` and contains the imported Route 53 zone reference, ACM certificate, CloudFront, WAF, Lambda@Edge payload hasher, website bucket, and MCP Lambda/Function URL. When the workload region differs from `us-east-1`, CDK cross-region references connect the stacks.

## Prerequisites

- Node.js 22 (the root package requires `>=22 <23`) and Corepack.
- pnpm **10.28.1**, pinned by `packageManager` and CI.
- Docker with BuildKit for image builds and CDK Docker image assets.
- Git and pandoc for a local ingestion run. The ingestion image pins pandoc 3.6.4 and installs Git itself.
- AWS CLI v2 and AWS credentials only for bootstrap, deployment, AWS-backed local runs, or operations.
- An AWS account and workload region where Amazon Bedrock Knowledge Bases, the `amazon.titan-embed-text-v2:0` model, and S3 Vectors are available. Confirm model access, service quotas, and regional support before deployment.
- An existing public Route 53 hosted zone that contains the environment domain.
- A modern CDK bootstrap in the target account's `us-east-1` region and, when different, the workload region. The deployment workflow deliberately does not bootstrap accounts.

Bootstrap each required region once with suitably privileged credentials:

```bash
ACCOUNT_ID=000000000000
WORKLOAD_REGION=us-west-2
pnpm --dir packages/cdk exec cdk bootstrap "aws://${ACCOUNT_ID}/us-east-1"
if [ "$WORKLOAD_REGION" != us-east-1 ]; then
  pnpm --dir packages/cdk exec cdk bootstrap "aws://${ACCOUNT_ID}/${WORKLOAD_REGION}"
fi
```

CDK image and file assets, cross-region references, and the standard bootstrap roles depend on a current bootstrap stack. Do not run bootstrap from the GitHub deployment role.

### DNS and certificate expectations

The CDK app imports, but does not create, the configured hosted zone. `domain` must equal `hostedZoneName` or be a descendant of it. The deployment role needs permission to create the certificate validation records and the final `A`/`AAAA` aliases. ACM validation can remain pending until the zone is publicly authoritative.

If `hostedZoneName` is a delegated child zone, create its `NS` delegation in the parent DNS provider before deployment. The CDK stacks do not create parent-zone delegation. The CloudFront certificate is created in `us-east-1`, as required by CloudFront.

## Local development

### Install, quality, test, and build

From the repository root:

```bash
corepack enable
corepack prepare pnpm@10.28.1 --activate
pnpm install --frozen-lockfile
pnpm quality       # prettier check, ESLint, and TypeScript checks
pnpm test          # functions, ingestion, and CDK tests
pnpm build         # build all three packages
```

To synthesize both environments without AWS lookups, copy the ignored context file, replace only placeholders, and run:

```bash
cp packages/cdk/cdk.context.json.example packages/cdk/cdk.context.json
pnpm --dir packages/cdk exec cdk synth --context environment=staging --output cdk.out --quiet
pnpm --dir packages/cdk exec cdk synth --context environment=production --output cdk.out --quiet
```

The second command replaces the same `cdk.out`; run them sequentially. If both assemblies must be retained, put each `--output` outside the repository (for example under `/tmp`) so a Docker asset cannot recursively include a custom in-repository output directory.

### Docker builds

These produce the same Linux/AMD64 image targets used by CI and CDK assets:

```bash
docker build --platform linux/amd64 --file packages/cdk/docker/mcp.Dockerfile --tag smithy-mcp-server:local .
docker build --platform linux/amd64 --build-arg TARGETARCH=amd64 --file packages/ingestion/Dockerfile --tag smithy-mcp-ingestion:local .
```

### Run the MCP server locally

The local server still requires real AWS-backed S3 and Bedrock resources plus credentials authorized to read/retrieve them:

```bash
pnpm build
export AWS_RESOURCE_REGION=us-west-2
export AWS_REGION="$AWS_RESOURCE_REGION"
export BUCKET_NAME='<BucketName output>'
export KNOWLEDGE_BASE_ID='<KnowledgeBaseId output>'
export MCP_ALLOWED_HOSTS='localhost:8080'
export MCP_ALLOWED_ORIGINS='http://localhost:8080'
export PORT=8080
pnpm start
```

Requests without an `Origin` header are accepted when `Host` is allowed; browser requests must use an exact configured origin. To run the built image instead, pass the same variables and credentials:

```bash
docker run --rm -p 8080:8080 \
  -e AWS_REGION -e AWS_RESOURCE_REGION -e BUCKET_NAME -e KNOWLEDGE_BASE_ID \
  -e MCP_ALLOWED_HOSTS -e MCP_ALLOWED_ORIGINS \
  -v "$HOME/.aws:/home/node/.aws:ro" \
  smithy-mcp-server:local
```

### Run ingestion locally

The CLI always requires `BUCKET_NAME`; Git and pandoc must be on `PATH`. If `KNOWLEDGE_BASE_ID` and `DATA_SOURCE_ID` are both omitted, it publishes S3 documents without starting Bedrock sync. If supplied, both must be 10-character alphanumeric IDs and the CLI waits for sync completion.

```bash
export AWS_REGION=us-west-2
export BUCKET_NAME='<BucketName output>'
export KNOWLEDGE_BASE_ID='<KnowledgeBaseId output>'
export DATA_SOURCE_ID='<DataSourceId output>'
pnpm ingest
```

Useful optional ingestion variables are `SOURCE_REPOSITORY`, `SOURCE_REF`, `DOCS_PREFIX`, `FORCE_REFRESH`, `COMMAND_TIMEOUT_MS`, `COMMAND_MAX_OUTPUT_BYTES`, `CONVERSION_CONCURRENCY`, `S3_CONCURRENCY`, `INGESTION_POLL_INTERVAL_MS`, `INGESTION_POLL_MAX_INTERVAL_MS`, and `INGESTION_TIMEOUT_MS`. The deployed Lambda sets these to the values in `smithy-knowledge-base-stack.ts`; in particular it reads `smithy-lang/smithy` at `main`, publishes `smithy-docs/`, and uses a 13-minute Bedrock timeout within its 15-minute Lambda timeout.

The ingestion container is a Lambda image. For local Runtime Interface Emulator execution:

```bash
docker run --rm -p 9000:8080 \
  -e AWS_REGION -e BUCKET_NAME -e KNOWLEDGE_BASE_ID -e DATA_SOURCE_ID \
  -v "$HOME/.aws:/root/.aws:ro" \
  smithy-mcp-ingestion:local
# In another shell; this invokes the local container, whose handler accesses the configured AWS resources.
curl --fail-with-body -X POST \
  http://localhost:9000/2015-03-31/functions/function/invocations \
  -H 'Content-Type: application/json' -d '{}'
```

## CDK context

The app selects `staging` by default; pass `--context environment=production` explicitly for production. `packages/cdk/cdk.context.json` is ignored because it contains environment-specific values. The complete schema for each top-level `staging` or `production` object is:

| Key | Required | Validation/default |
| --- | --- | --- |
| `account` | yes | 12-digit string. |
| `region` | yes | Workload AWS region; edge remains `us-east-1`. |
| `domain` | yes | Non-empty, lowercased, and inside `hostedZoneName`. |
| `hostedZoneId` | yes | Imported Route 53 hosted zone ID. |
| `hostedZoneName` | yes | Imported zone name; one trailing dot is removed. |
| `budgetLimitUsd` | no | Positive number; must be paired with `budgetNotificationEmail`. |
| `budgetNotificationEmail` | no | Non-empty notification address; must be paired with `budgetLimitUsd`. |
| `mcpReservedConcurrency` | no | Positive integer; default 10 for staging and 50 for production. |
| `wafRateLimit` | no | Positive integer requests per source IP per five-minute window; default 500 for staging and 2,000 for production. |

The checked-in [example](packages/cdk/cdk.context.json.example) uses reserved example values only. CI/deployment generate the same shape with `scripts/write-cdk-context.mjs` from `CDK_*` environment variables and write it with mode `0600`.

## CI/CD and GitHub OIDC

### Triggers and gates

- `.github/workflows/ci.yml` runs on pushes and pull requests targeting `main`, plus manual dispatch. It performs a high-severity production dependency audit, format/lint/type checks, tests, builds, no-lookup synths for both environments, and both Docker builds.
- A successful `CI` workflow caused by a push to this repository's `main` branch triggers an automatic **staging** deployment of that exact validated SHA.
- A manual `Deploy` workflow dispatch from `main` targets **production** only and requires the input `deploy-production` exactly.
- Deployments serialize per environment, do not cancel in progress, use a 90-minute job timeout to leave first-deploy margin for serialized CloudFront/Bedrock stacks plus the synchronous ingestion window, repeat quality gates before credentials, acquire short-lived AWS credentials only in the deploy job, synchronously refresh documentation and wait for Bedrock sync, verify initialize/list/read/search readiness, and retain `packages/cdk/cdk-outputs.json` as a 14-day artifact.

Create GitHub Environments named `staging` and `production`. Restrict both to `main`; require reviewers for production. Staging reviewers would pause the otherwise automatic staging deployment. Set these environment variables:

| Variable | Required | Purpose |
| --- | --- | --- |
| `AWS_ACCOUNT_ID` | yes | Target account. |
| `AWS_DEPLOY_ROLE_ARN` | yes, variable or secret | Environment-specific OIDC role. |
| `AWS_WORKLOAD_REGION` | yes | Bedrock/S3 Vectors/ingestion region. |
| `DOMAIN_NAME` | yes | Public environment domain. |
| `HOSTED_ZONE_ID` | yes | Existing Route 53 zone ID. |
| `HOSTED_ZONE_NAME` | yes | Existing Route 53 zone name. |
| `MCP_SMOKE_URL` | yes | Exactly `https://DOMAIN_NAME/mcp`. |
| `BUDGET_LIMIT_USD` and `BUDGET_NOTIFICATION_EMAIL` | optional pair | Environment budget. |
| `MCP_RESERVED_CONCURRENCY` | optional | MCP Lambda reserved concurrency. |
| `WAF_RATE_LIMIT` | optional | WAF five-minute per-IP rate. |

`MCP_SMOKE_BEARER_TOKEN` is an optional environment **secret** that makes the smoke script send an `Authorization: Bearer` header. Nothing in the application or provisioned stack validates that token; configure an external viewer-auth layer before relying on it.

The CI synth job optionally reads repository variables prefixed with `STAGING_` or `PRODUCTION_`: `AWS_ACCOUNT_ID`, `AWS_WORKLOAD_REGION`, `DOMAIN_NAME`, `HOSTED_ZONE_ID`, and `HOSTED_ZONE_NAME`. Safe `.invalid` fallbacks make synth validation independent of AWS credentials.

Configure GitHub's OIDC provider in each target account and use a separate role per environment. Its trust policy must bind the audience, repository, and protected Environment; do not trust all branches or repositories. Replace placeholders in this trust-policy statement:

```json
{
  "Effect": "Allow",
  "Principal": {
    "Federated": "arn:aws:iam::<ACCOUNT_ID>:oidc-provider/token.actions.githubusercontent.com"
  },
  "Action": "sts:AssumeRoleWithWebIdentity",
  "Condition": {
    "StringEquals": {
      "token.actions.githubusercontent.com:aud": "sts.amazonaws.com",
      "token.actions.githubusercontent.com:sub": "repo:<OWNER>/<REPOSITORY>:environment:staging"
    }
  }
}
```

Use `environment:production` for the production role. Grant the role only the access needed to assume the modern CDK bootstrap publishing/deploy roles in `us-east-1` and the workload region, plus `lambda:InvokeFunction` on the exact `smithy-mcp-<environment>-ingestion` function used by the post-deployment readiness gate. Account owners remain responsible for reviewing the synthesized IAM and CloudFormation changes, bootstrap policies, permissions boundaries, and any organization SCPs.

## Deployment and first ingestion

The recommended path is the GitHub workflow above. For an authorized local deployment after quality gates and synth, select and validate the target explicitly:

```bash
ENVIRONMENT=staging # or production
case "$ENVIRONMENT" in staging|production) ;; *) exit 2 ;; esac
pnpm --dir packages/cdk exec cdk deploy --all \
  --context "environment=${ENVIRONMENT}" \
  --concurrency 1 \
  --require-approval never \
  --outputs-file cdk-outputs.json
```

Review `pnpm --dir packages/cdk exec cdk diff --all --context "environment=${ENVIRONMENT}"` before a local deployment; `--require-approval never` is shown only because it matches automation. Stack names are `smithy-mcp-<environment>-dns`, `smithy-mcp-<environment>-knowledge-base`, and `smithy-mcp-<environment>-server`.

The GitHub deployment workflow invokes the deployed ingestion Lambda synchronously after CloudFormation completes, waits for publication and Bedrock sync, and then requires initialize/list/read/search smoke checks to pass. This makes a first workflow deployment usable rather than leaving an empty knowledge base. The workflow's OIDC role therefore needs `lambda:InvokeFunction` on only that environment's ingestion function.

An authorized local deployment does not invoke ingestion automatically. After the knowledge-base stack reaches `CREATE_COMPLETE`, use its actual `IngestionFunctionName` output for the first asynchronous invocation:

```bash
ENVIRONMENT=staging
WORKLOAD_REGION=us-west-2
STACK="smithy-mcp-${ENVIRONMENT}-knowledge-base"
INGESTION_FUNCTION=$(aws cloudformation describe-stacks \
  --region "$WORKLOAD_REGION" --stack-name "$STACK" \
  --query "Stacks[0].Outputs[?OutputKey=='IngestionFunctionName'].OutputValue | [0]" \
  --output text)
aws lambda invoke --region "$WORKLOAD_REGION" \
  --function-name "$INGESTION_FUNCTION" \
  --invocation-type Event --cli-binary-format raw-in-base64-out \
  --payload '{}' initial-ingestion.json
```

The stack also emits `InitialIngestionCommand` with this complete command for operator review. Monitor logs and the DLQ rather than treating the asynchronous CLI response as completion. The same invocation is the supported manual ingestion trigger. The EventBridge schedule runs every **Monday at 06:00 UTC** (`cron(0 6 ? * MON *)`).

### Rollback

CloudFormation automatically rolls back a failed stack update. For a successfully deployed but bad application/infrastructure revision:

1. Preserve deployment outputs and CloudWatch evidence; stop further promotion.
2. Revert the bad commit on `main` through normal review. The resulting successful CI run redeploys staging; verify it there, then manually promote production. This preserves the workflow's exact-SHA and protected-environment controls.
3. If urgent authorized local recovery is required, check out a reviewed known-good revision in a separate clean worktree, regenerate the same environment context, run `cdk diff`, then deploy all stacks with the command above. Do not reuse stale `cdk.out` assets.
4. Infrastructure rollback does not roll back retained S3 documents or vectors. To republish an older Smithy commit, quiesce scheduled ingestion and run the local CLI with `SOURCE_REF=<reviewed-commit-sha>` and `FORCE_REFRESH=true`; Bedrock sync follows. Re-enable the schedule only after deciding whether the next `main` refresh should supersede that content.

## Ingestion, publication, and Bedrock sync

The ingestion Lambda has one reserved concurrent execution, two asynchronous retries, a two-hour maximum event age, a 15-minute timeout, 2 GiB memory, and 4 GiB ephemeral storage. Each run sparse-fetches only `docs/` from the configured Git ref, resolves the immutable upstream SHA, converts `docs/source-2.0/**/*.rst` with pandoc, and adds deterministic front matter.

Publication is staged, guarded, and convergent:

- Live reader-visible Markdown is under `smithy-docs/` (or the configured `DOCS_PREFIX`). The MCP Lambda and Bedrock data source read only the default `smithy-docs/` prefix.
- Control state is under `smithy-mcp-state/<sha256(normalized-docs-prefix)>/`: `manifest.json`, the temporary `_publication-lock.json`, `_sync-pending.json`, immutable per-job records below `_sync-jobs/`, and per-publication completion witnesses below `_sync-completed/`. None of these keys is in the live documentation prefix.
- Staged documents are under `smithy-mcp-staging/<same-prefix-hash>/<UUID>/` and are never visible to the MCP server or Bedrock data source.
- If repository URL and upstream SHA match the manifest and `FORCE_REFRESH=false`, conversion/publication is skipped. Otherwise every new document is staged with a checksum, then a conditional 14-minute lock is acquired. The manifest ETag is rechecked, staged files are copied to live keys, stale live Markdown is deleted, staging is cleaned, and the manifest is conditionally committed last.
- Repeating a run converges on the same document set. A process failure before live copying leaves old live content. A failure during copy/delete can temporarily leave a mixed live set because S3 has no multi-object transaction; the unchanged manifest and next run drive repair.
- Caught failures attempt to delete that run's staged keys. A hard timeout or process termination can bypass cleanup and leave current objects under a unique staging UUID. A lifecycle rule scoped exclusively to `smithy-mcp-staging/` expires current and noncurrent staged objects after two days and aborts incomplete staged multipart uploads after two days. This is safely longer than the 14-minute publication lock and cannot expire live `smithy-docs/` or control `smithy-mcp-state/` objects.

After publication, the pipeline first persists `_sync-pending.json` with the deterministic publication identity, knowledge-base/data-source tuple, owner, and reusable Bedrock client token using an S3 create-if-absent precondition. A retry for that desired synchronization reuses the record. Once `StartIngestionJob` returns, the job ID is added with an ETag-conditional update; retries with a persisted job ID poll it directly instead of creating another job. Completion writes an immutable per-client-token job record and a create-only publication completion witness before conditionally deleting only the matching pending record. A pending record for another publication or Bedrock tuple is displaced with an ETag-conditional delete, malformed control JSON fails closed, and racing cleanup never deletes a replacement owner. Known terminal Bedrock failures release their matching pending record so a later invocation can start a fresh job; timeouts and uncertain API failures retain it for safe resumption.

There is one unavoidable micro-window: Bedrock may accept `StartIngestionJob` but the process can lose the response before its job ID is persisted. The next invocation reissues `StartIngestionJob` with the same client token, which minimizes duplicates through Bedrock's idempotency contract, but there is no separate API to recover an unknown job ID from that token if the service no longer returns the original accepted job. Once the job ID is persisted, retries do not depend on token lookup and poll that exact job. `FORCE_REFRESH=true` still republishes and starts a fresh synchronization when no matching pending operation exists; a matching pending operation is always treated as recovery of that in-flight forced refresh rather than starting a duplicate.

Failed, stopped, unknown, or timed-out jobs fail the Lambda. If publication is unchanged and no matching completion witness exists, the next run retries Bedrock sync without republishing. A process crash after Bedrock completion but before marker/cleanup completion resumes the persisted job, repairs durable completion state, and conditionally clears pending state. Consequently, direct read/list can show newly published files while semantic search still reflects the last successful Bedrock sync.

## Operations

### Logs and alarms

Log groups `/aws/lambda/smithy-mcp-<environment>-ingestion` and `/aws/lambda/smithy-mcp-<environment>-server` retain logs for one year and are retained on stack deletion. Both Lambdas use active X-Ray tracing.

```bash
aws logs tail "/aws/lambda/smithy-mcp-${ENVIRONMENT}-ingestion" --region "$WORKLOAD_REGION" --since 1h --follow
aws logs tail "/aws/lambda/smithy-mcp-${ENVIRONMENT}-server" --region us-east-1 --since 1h --follow
```

CloudWatch alarms fire on any ingestion error, ingestion duration at or above 14 minutes, visible DLQ messages, any MCP error, any MCP throttle, MCP p99 duration at or above 25 seconds, and a sustained CloudFront 5xx error rate of at least 5% for two consecutive five-minute periods. The CloudFront metric includes 5xx responses generated at the edge and those returned by the origin path. Missing data is non-breaching. The stacks do **not** attach SNS or incident actions; operators must route alarm state changes through their monitoring system.

The stack does not provision a synthetic canary or a dedicated alarm for the Lambda@Edge payload hasher. The post-deployment readiness check covers initialize/list/read/search once per deployment, but continuous external endpoint monitoring is still recommended. Lambda@Edge execution logs are written in AWS Regions where CloudFront executes the replica; locate log groups by the `smithy-mcp-<environment>-payload-hash` function name rather than assuming they are in the workload region.

### DLQ inspection and replay

The encrypted queue `smithy-mcp-<environment>-ingestion-dlq` retains messages for 14 days and receives EventBridge target failures and exhausted Lambda asynchronous failures.

```bash
QUEUE_NAME="smithy-mcp-${ENVIRONMENT}-ingestion-dlq"
QUEUE_URL=$(aws sqs get-queue-url --region "$WORKLOAD_REGION" \
  --queue-name "$QUEUE_NAME" --query QueueUrl --output text)
aws sqs receive-message --region "$WORKLOAD_REGION" --queue-url "$QUEUE_URL" \
  --max-number-of-messages 10 --visibility-timeout 300 --wait-time-seconds 10 \
  --attribute-names All --message-attribute-names All
```

This queue is a failure destination, not a source queue with an SQS redrive policy, so `start-message-move-task` is not the replay mechanism. Inspect the envelope and logs, correct the cause, manually invoke the ingestion Lambda with `{}`, verify publication and Bedrock sync completion, and only then delete the corresponding message with its receipt handle. Never delete unreviewed messages merely to clear the alarm.

### Publication-lock recovery

Normal failures conditionally release their lock. A nonexpired lock means another publisher may be active. An expired `acquired` lock is removed automatically on the next run. An expired `publishing` lock deliberately fails closed because live copying may have been interrupted.

For an expired `publishing` lock:

1. Disable the Monday EventBridge rule and confirm no ingestion invocation is running. Preserve the lock body, ETag, logs, current manifest, and bucket versions for audit/recovery.
2. Compute the control key for the deployed default prefix and inspect it:

   ```bash
   PREFIX_ID=$(node -e "process.stdout.write(require('node:crypto').createHash('sha256').update('smithy-docs/').digest('hex'))")
   LOCK_KEY="smithy-mcp-state/${PREFIX_ID}/_publication-lock.json"
   aws s3api get-object --region "$WORKLOAD_REGION" --bucket "$BUCKET_NAME" \
     --key "$LOCK_KEY" publication-lock.json
   ```

3. Verify the recorded owner is no longer running and `expiresAt` is in the past. Prepare a credentialed local ingestion with the same source and `FORCE_REFRESH=true`. Delete only the observed current lock with its ETag as a precondition, then immediately run the forced refresh:

   ```bash
   LOCK_ETAG=$(aws s3api head-object --region "$WORKLOAD_REGION" \
     --bucket "$BUCKET_NAME" --key "$LOCK_KEY" --query ETag --output text)
   aws s3api delete-object --region "$WORKLOAD_REGION" \
     --bucket "$BUCKET_NAME" --key "$LOCK_KEY" --if-match "$LOCK_ETAG"
   AWS_REGION="$WORKLOAD_REGION" BUCKET_NAME="$BUCKET_NAME" \
     KNOWLEDGE_BASE_ID="$KNOWLEDGE_BASE_ID" DATA_SOURCE_ID="$DATA_SOURCE_ID" \
     SOURCE_REF=main FORCE_REFRESH=true pnpm ingest
   ```

   If the installed AWS CLI does not expose conditional `delete-object --if-match`, use an approved version-aware S3 console or SDK procedure rather than an unconditional scripted delete.
4. Confirm `publication_completed` and `bedrock_sync_completed`, compare the new manifest SHA/count, run smoke tests, and re-enable the schedule.

Never resolve this state by deleting the lock and allowing an unchanged-SHA run: the manifest can still describe the pre-failure commit while live keys are mixed. Restore bucket object versions only when you have a separately reviewed version-level recovery plan.

### Smoke tests

The smoke script always validates an MCP `initialize` response over HTTPS, retries up to five times, rejects redirects, applies a 10-second per-request timeout, and bounds each response to 1 MiB:

```bash
MCP_SMOKE_URL="https://${DOMAIN_NAME}/mcp" pnpm smoke:mcp
```

Optional controls are `MCP_PROTOCOL_VERSION`, `MCP_SMOKE_ATTEMPTS` (1–10), `MCP_SMOKE_TIMEOUT_MS` (1,000–60,000), and `MCP_SMOKE_BEARER_TOKEN`. Setting `MCP_SMOKE_REQUIRE_CONTENT=true` additionally requires `list_smithy_topics` to return at least one path, reads that path, and requires a semantic search result. The deployment workflow enables this only after its synchronous ingestion has completed; it therefore validates S3 publication and Bedrock retrieval as well as transport initialization.

## Security boundaries and responsibilities

Implemented controls include private encrypted S3 buckets, SSL-only bucket policies, S3 object versioning for docs, an IAM-authenticated Function URL restricted to CloudFront, OAC signing, TLS 1.2+, ACM/Route 53 ownership validation, WAF body/rate rules, security response headers, exact host/origin validation, path traversal rejection, bounded requests/results/listing/command output, source repository/ref validation, checksummed staged publication, conditional S3 state/locks, stage-qualified resources, least-privilege Lambda and Bedrock roles, reserved concurrency, X-Ray, retained logs, alarms, and DLQ capture. The Knowledge Base role also restricts its service trust by source account and knowledge-base ARN.

Operators remain responsible for viewer authentication if needed, OIDC and bootstrap-role least privilege, branch/environment protection, AWS account/SCP boundaries, secret handling, DNS delegation, model/service availability, quota planning, alarm routing and response, CloudTrail/security monitoring, WAF tuning, dependency and base-image patching, cost controls, data classification, and recovery exercises. The service publishes upstream Smithy documentation; review source licensing and any organization-specific data requirements before changing the source repository.

## Cost and budgets

Primary variable cost drivers are CloudFront requests/transfer and Lambda@Edge, WAF requests/rules, MCP and ingestion Lambda duration, S3 live/staged/noncurrent storage and requests, S3 Vectors storage/query/write operations, Bedrock embedding and retrieval usage, CloudWatch Logs/X-Ray, Route 53, ECR/CDK assets, and cross-region/API data transfer. Actual prices and regional support change; estimate with current AWS pricing and expected document/query volume rather than relying on a fixed monthly figure.

When both context values are set, CDK creates a monthly cost budget filtered to the environment tag and emails at 80% of **forecasted** spend. A budget alerts but does not cap resources. Enable cost-allocation tags and understand that untagged or unsupported charges may fall outside this filter.

## Dependency updates

Dependabot opens grouped updates every Monday at 09:00 UTC for pnpm production/development dependencies, GitHub Actions, and both Docker directories. Actions are pinned by commit SHA and pandoc downloads by version and architecture-specific SHA-256.

For manual JavaScript updates:

```bash
corepack prepare pnpm@10.28.1 --activate
pnpm outdated -r
pnpm update -r
pnpm install --frozen-lockfile
pnpm quality && pnpm test && pnpm build
# Also run the two Docker builds and both environment synths shown above.
```

Review `pnpm-lock.yaml`, release notes, synthesized templates, image changes, and dependency audit output. Change the root `packageManager`, CI `PNPM_VERSION`, and documentation together when upgrading pnpm. Update Docker tags/digests and pandoc checksums deliberately; never bypass checksum validation.

## Deletion and retention

Production stacks have termination protection; disable it only through an approved teardown. The documentation bucket, website bucket, S3 Vectors bucket/index, and explicit Lambda log groups use `RETAIN`; the docs bucket also refuses automatic object deletion. Destroying stacks therefore does not erase retained data and can fail while retained/dependent resources remain. The DLQ is not retained and its messages expire after 14 days. The docs bucket lifecycle is scoped only to `smithy-mcp-staging/`: current and noncurrent staged objects expire after two days, and incomplete staged multipart uploads abort after two days. No lifecycle action targets current or noncurrent live `smithy-docs/` or control `smithy-mcp-state/` objects. Website deployment uses `prune: true`, so a deployment removes current website objects absent from `packages/cdk/src`, although the bucket itself is retained on stack deletion. Current live/control objects, their versions, vectors, and retained logs otherwise have no automatic deletion in this code.

Before teardown, export required evidence/data, stop schedules and traffic, record retained physical resource names, understand Bedrock/data-source dependencies, and plan manual deletion in the correct region. Retained resources continue to incur cost and may block redeployment with the same deterministic names.

## Troubleshooting

- **Synth reports missing/invalid context:** select `staging` or `production`; ensure the chosen top-level object contains all required keys, the account has 12 digits, the domain is in the hosted zone, optional numbers are positive, and budget fields are paired.
- **Deploy fails before resources are created:** verify modern bootstrap stacks in both required regions, Docker availability, deployment-role access to bootstrap roles, quotas, and that S3 Vectors/Bedrock are supported in the workload region.
- **ACM validation or CloudFront deployment stalls:** confirm the imported zone ID/name is authoritative, child-zone delegation exists, validation records are not blocked by restrictive CAA, and the certificate is being created in `us-east-1`. CloudFront propagation can take time.
- **`403`, `502`, or `503` at `/mcp`:** use the custom HTTPS domain, exact `/mcp`, and an allowed `Origin` or no `Origin`. Direct Function URL calls require AWS IAM and are not a supported viewer path. Check WAF sampled requests, CloudFront 5xx/origin metrics, distributed Lambda@Edge payload-hasher logs, OAC permissions, the 64 KiB body cap, and the pinned host header.
- **`404` or static HTML instead of MCP:** only exact `/mcp` selects the MCP behavior; `/mcp/` uses the default behavior.
- **No topics/read failures:** inspect live objects under `s3://<bucket>/smithy-docs/`, ingestion logs, the manifest, and MCP Lambda S3 permissions. The first deployment is empty until explicit ingestion.
- **Search is empty but read/list works:** inspect `_sync-pending.json`, the publication witness below `_sync-completed/`, the matching immutable record below `_sync-jobs/`, Bedrock ingestion job status/failure reasons, model access, data-source prefix, S3 Vectors support, and knowledge-base IAM. A publication can be newer than the last successful sync.
- **Ingestion skips unexpectedly:** matching source repository and upstream SHA is intentionally idempotent. Set `FORCE_REFRESH=true` only for an authorized repair; do not change the deployed Lambda environment by hand because CDK will revert drift.
- **Ingestion times out or reaches the DLQ:** inspect structured log events, GitHub/pandoc network access, temporary storage, command limits, the 14-minute duration alarm, Bedrock polling, publication lock state, and orphaned `smithy-mcp-staging/` prefixes before replay.
- **MCP throttles or latency alarms:** inspect reserved concurrency, Bedrock/S3 latency and quotas, WAF activity, Lambda p99 duration, and workload-region cross-region calls before raising limits.

## License

[MIT](LICENSE) © 2026 Ryan Cormack.
