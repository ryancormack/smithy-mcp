# Smithy MCP Server

An MCP (Model Context Protocol) server that exposes Smithy CLI documentation through AWS Bedrock Knowledge Bases with semantic search capabilities.

## Architecture

```
Smithy Docs (GitHub) → Ingestion Script → S3 (docs) → Bedrock Knowledge Base → S3 Vectors (embeddings) → Lambda (MCP Server) → Public Function URL
```

Uses **S3 Vectors** for cost-effective vector storage (~$5/month vs ~$705/month with OpenSearch Serverless).

## Features

- **Semantic Search**: Search Smithy documentation using natural language queries
- **Full Document Access**: Read complete documentation files
- **Topic Listing**: Browse all available documentation
- **Public API**: Accessible via Lambda Function URL
- **MCP Compatible**: Works with Claude Desktop and other MCP clients

## Project Structure

```
smithy-mcp-server/
├── packages/
│   ├── ingestion/       # Clone, convert, and upload Smithy docs
│   ├── functions/       # MCP server Lambda functions
│   └── cdk/            # Infrastructure as code
├── package.json
└── pnpm-workspace.yaml
```

## Prerequisites

- Node.js 20+
- pnpm
- AWS CLI configured
- AWS CDK CLI (`npm install -g aws-cdk`)
- pandoc (`brew install pandoc` on macOS)

## Setup

### 1. Install Dependencies

```bash
pnpm install
```

### 2. Build All Packages

```bash
pnpm build
```

### 3. Deploy Infrastructure

```bash
cd packages/cdk
pnpm cdk bootstrap  # First time only
pnpm deploy
```

Save the output values:
- `SmithyDocsBucketName`
- `SmithyKnowledgeBaseId`
- `SmithyMcpServerUrl`

### 5. Run Ingestion

```bash
export BUCKET_NAME=<SmithyDocsBucketName>
pnpm ingest
```

### 6. Sync Knowledge Base

```bash
# Get data source ID
aws bedrock-agent list-data-sources \
  --knowledge-base-id <SmithyKnowledgeBaseId>

# Start sync
aws bedrock-agent start-ingestion-job \
  --knowledge-base-id <SmithyKnowledgeBaseId> \
  --data-source-id <DataSourceId>
```

Wait 5-10 minutes for sync to complete.

## Usage

### Test with curl

```bash
# Search documentation
curl -X POST <SmithyMcpServerUrl> \
  -H "Content-Type: application/json" \
  -d '{
    "jsonrpc": "2.0",
    "method": "tools/call",
    "params": {
      "name": "search_smithy_docs",
      "arguments": {"query": "How do I define a service?"}
    },
    "id": 1
  }'

# List all topics
curl -X POST <SmithyMcpServerUrl> \
  -H "Content-Type: application/json" \
  -d '{
    "jsonrpc": "2.0",
    "method": "tools/call",
    "params": {"name": "list_smithy_topics", "arguments": {}},
    "id": 2
  }'

# Read specific document
curl -X POST <SmithyMcpServerUrl> \
  -H "Content-Type: application/json" \
  -d '{
    "jsonrpc": "2.0",
    "method": "tools/call",
    "params": {
      "name": "read_smithy_doc",
      "arguments": {"file_path": "quickstart.md"}
    },
    "id": 3
  }'
```

### Use with Claude Desktop

Add to `~/Library/Application Support/Claude/claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "smithy-docs": {
      "url": "<SmithyMcpServerUrl>",
      "transport": "http"
    }
  }
}
```

Restart Claude Desktop and ask questions like:
- "Search the Smithy docs for service definitions"
- "How do I use Smithy traits?"
- "Show me Smithy model examples"

## Available Tools

### search_smithy_docs
Search documentation using semantic search.

**Parameters:**
- `query` (string, required): Search query
- `max_results` (number, optional): Max results (1-10, default: 5)

### read_smithy_doc
Read full content of a documentation file.

**Parameters:**
- `file_path` (string, required): Relative path to file

### list_smithy_topics
List all available documentation files.

**Parameters:** None

## Development

```bash
# Build all packages
pnpm build

# Deploy changes
cd packages/cdk && pnpm deploy

# Update documentation
export BUCKET_NAME=<SmithyDocsBucketName>
pnpm ingest
# Then trigger KB sync again
```

## Cost Estimate

- **S3 (docs)**: ~$0.50/month (20GB)
- **S3 Vectors**: ~$0.50/month (embeddings storage)
- **Bedrock Embeddings**: ~$2 (one-time ingestion)
- **Bedrock Retrieval**: ~$2/month (50K queries)
- **Lambda**: ~$0.40/month (2M requests)

**Total**: ~$5.40/month (vs ~$705 with OpenSearch Serverless!)

## Troubleshooting

### Knowledge Base sync fails
Check IAM permissions. The KB role needs `s3:GetObject` and `bedrock:InvokeModel`.

### Lambda timeout
Increase timeout in `packages/cdk/lib/smithy-mcp-server-stack.ts`.

### No search results
1. Verify files in S3
2. Check KB sync status
3. Try broader search terms

## License

MIT
