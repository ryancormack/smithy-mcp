# Smithy Documentation MCP Server - Implementation Guide

## Overview

This guide details how to build an MCP (Model Context Protocol) server that exposes Smithy CLI documentation through a public API endpoint. The solution uses AWS Bedrock Knowledge Bases for vector storage and semantic search, with infrastructure deployed via CDK.

## Architecture

```
┌─────────────────────┐
│  Smithy Docs Repo   │
│  (GitHub)           │
└──────────┬──────────┘
           │
           │ (one-time ingestion)
           ▼
┌─────────────────────┐
│  Ingestion Script   │
│  - Clone docs       │
│  - Convert RST→MD   │
│  - Upload to S3     │
└──────────┬──────────┘
           │
           ▼
┌─────────────────────────────────────┐
│  S3 Bucket                          │
│  └─ smithy-docs/                    │
│     ├─ quickstart.md                │
│     ├─ guides/                      │
│     └─ spec/                        │
└──────────┬──────────────────────────┘
           │
           │ (syncs from)
           ▼
┌─────────────────────────────────────┐
│  Bedrock Knowledge Base             │
│  - Titan Embeddings v2              │
│  - Vector search                    │
│  - Automatic chunking               │
└──────────┬──────────────────────────┘
           │
           │ (queries)
           ▼
┌─────────────────────────────────────┐
│  Lambda Function (MCP Server)       │
│  - search_smithy_docs               │
│  - read_smithy_doc                  │
│  - list_smithy_topics               │
└──────────┬──────────────────────────┘
           │
           ▼
┌─────────────────────────────────────┐
│  Lambda Function URL (Public)       │
│  https://xxx.lambda-url.region...   │
└─────────────────────────────────────┘
           │
           ▼
┌─────────────────────────────────────┐
│  MCP Clients (Claude, Agents)       │
└─────────────────────────────────────┘
```

## Project Structure

```
smithy-mcp-server/
├── pnpm-workspace.yaml
├── package.json
├── packages/
│   ├── cdk/
│   │   ├── package.json
│   │   ├── tsconfig.json
│   │   ├── cdk.json
│   │   ├── bin/
│   │   │   └── app.ts
│   │   └── lib/
│   │       ├── smithy-knowledge-base-stack.ts
│   │       └── smithy-mcp-server-stack.ts
│   ├── functions/
│   │   ├── package.json
│   │   ├── tsconfig.json
│   │   └── src/
│   │       ├── mcp-server/
│   │       │   ├── index.ts
│   │       │   ├── tools/
│   │       │   │   ├── search.ts
│   │       │   │   ├── read.ts
│   │       │   │   └── list.ts
│   │       │   └── bedrock-client.ts
│   │       └── common/
│   │           └── types.ts
│   └── ingestion/
│       ├── package.json
│       ├── tsconfig.json
│       └── src/
│           ├── index.ts
│           ├── clone-docs.ts
│           ├── convert-rst.ts
│           └── upload-s3.ts
├── .gitignore
└── README.md
```

## Phase 1: Project Setup

### 1.1 Initialize Monorepo

```bash
# Create project directory
mkdir smithy-mcp-server
cd smithy-mcp-server

# Initialize root package.json
pnpm init

# Create workspace file
cat > pnpm-workspace.yaml << EOF
packages:
  - 'packages/*'
EOF

# Create package directories
mkdir -p packages/{cdk,functions,ingestion}/src
```

### 1.2 Root package.json

```json
{
  "name": "smithy-mcp-server",
  "version": "1.0.0",
  "private": true,
  "scripts": {
    "build": "pnpm -r build",
    "deploy": "pnpm --filter @smithy-mcp/cdk deploy",
    "ingest": "pnpm --filter @smithy-mcp/ingestion start"
  },
  "devDependencies": {
    "@types/node": "^20.x.x",
    "typescript": "^5.3.0"
  }
}
```

### 1.3 Install Root Dependencies

```bash
pnpm install
```

## Phase 2: Ingestion Script

### 2.1 Setup Ingestion Package

```bash
cd packages/ingestion

# Create package.json
cat > package.json << 'EOF'
{
  "name": "@smithy-mcp/ingestion",
  "version": "1.0.0",
  "private": true,
  "type": "module",
  "scripts": {
    "build": "tsc",
    "start": "node dist/index.js"
  },
  "dependencies": {
    "@aws-sdk/client-s3": "^3.x.x",
    "@aws-sdk/lib-storage": "^3.x.x",
    "simple-git": "^3.x.x",
    "gray-matter": "^4.x.x",
    "glob": "^10.x.x"
  },
  "devDependencies": {
    "@types/node": "^20.x.x",
    "typescript": "^5.3.0"
  }
}
EOF

# Create tsconfig
cat > tsconfig.json << 'EOF'
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ES2022",
    "lib": ["ES2022"],
    "moduleResolution": "node",
    "outDir": "./dist",
    "rootDir": "./src",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "forceConsistentCasingInFileNames": true,
    "resolveJsonModule": true
  },
  "include": ["src/**/*"],
  "exclude": ["node_modules", "dist"]
}
EOF

pnpm install
```

### 2.2 Create Ingestion Script

**File: `packages/ingestion/src/index.ts`**

```typescript
import { cloneDocs } from './clone-docs.js';
import { convertRstToMarkdown } from './convert-rst.js';
import { uploadToS3 } from './upload-s3.js';

const BUCKET_NAME = process.env.BUCKET_NAME || 'smithy-docs-bucket';
const DOCS_PREFIX = 'smithy-docs/';

async function main() {
  console.log('Starting Smithy documentation ingestion...');
  
  try {
    // Step 1: Clone the Smithy docs repository
    console.log('Step 1: Cloning Smithy repository...');
    const docsPath = await cloneDocs();
    console.log(`✓ Cloned to: ${docsPath}`);
    
    // Step 2: Convert RST files to Markdown
    console.log('Step 2: Converting RST to Markdown...');
    const markdownFiles = await convertRstToMarkdown(docsPath);
    console.log(`✓ Converted ${markdownFiles.length} files`);
    
    // Step 3: Upload to S3
    console.log('Step 3: Uploading to S3...');
    await uploadToS3(markdownFiles, BUCKET_NAME, DOCS_PREFIX);
    console.log(`✓ Uploaded to s3://${BUCKET_NAME}/${DOCS_PREFIX}`);
    
    console.log('\n✓ Ingestion complete!');
    console.log('\nNext steps:');
    console.log('1. Wait for Knowledge Base to sync (may take 5-10 minutes)');
    console.log('2. Test the MCP server with a search query');
  } catch (error) {
    console.error('Error during ingestion:', error);
    process.exit(1);
  }
}

main();
```

**File: `packages/ingestion/src/clone-docs.ts`**

```typescript
import simpleGit from 'simple-git';
import { mkdtemp, rm } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';

const SMITHY_REPO = 'https://github.com/smithy-lang/smithy.git';
const DOCS_SUBDIR = 'docs';

export async function cloneDocs(): Promise<string> {
  // Create temporary directory
  const tempDir = await mkdtemp(join(tmpdir(), 'smithy-docs-'));
  
  try {
    const git = simpleGit();
    
    // Clone with sparse checkout for just the docs directory
    await git.clone(SMITHY_REPO, tempDir, [
      '--depth', '1',
      '--filter=blob:none',
      '--sparse'
    ]);
    
    // Configure sparse checkout to only include docs
    const repoGit = simpleGit(tempDir);
    await repoGit.raw(['sparse-checkout', 'set', DOCS_SUBDIR]);
    
    return join(tempDir, DOCS_SUBDIR);
  } catch (error) {
    // Clean up on error
    await rm(tempDir, { recursive: true, force: true });
    throw error;
  }
}
```

**File: `packages/ingestion/src/convert-rst.ts`**

```typescript
import { readFile, writeFile } from 'fs/promises';
import { glob } from 'glob';
import { join, relative, dirname, basename } from 'path';
import { exec } from 'child_process';
import { promisify } from 'util';
import matter from 'gray-matter';

const execAsync = promisify(exec);

export interface MarkdownFile {
  path: string;
  content: string;
  relativePath: string;
}

export async function convertRstToMarkdown(docsPath: string): Promise<MarkdownFile[]> {
  // Find all RST files
  const rstFiles = await glob('**/*.rst', { 
    cwd: docsPath,
    absolute: true 
  });
  
  console.log(`Found ${rstFiles.length} RST files to convert`);
  
  // Check if pandoc is available
  try {
    await execAsync('pandoc --version');
  } catch (error) {
    console.error('Pandoc not found. Installing...');
    console.error('Please install pandoc:');
    console.error('  macOS: brew install pandoc');
    console.error('  Ubuntu: apt-get install pandoc');
    console.error('  Windows: choco install pandoc');
    throw new Error('Pandoc is required but not installed');
  }
  
  const markdownFiles: MarkdownFile[] = [];
  
  for (const rstFile of rstFiles) {
    try {
      // Convert using pandoc
      const { stdout } = await execAsync(
        `pandoc "${rstFile}" -f rst -t markdown --wrap=none`
      );
      
      // Get relative path for S3 key
      const relativePath = relative(docsPath, rstFile)
        .replace(/\.rst$/, '.md');
      
      // Extract title from first heading if possible
      const lines = stdout.split('\n');
      const firstHeading = lines.find(l => l.startsWith('#'));
      const title = firstHeading 
        ? firstHeading.replace(/^#+\s*/, '').trim()
        : basename(rstFile, '.rst');
      
      // Add frontmatter for metadata
      const contentWithMeta = matter.stringify(stdout, {
        title,
        source: `smithy-docs/${relativePath}`,
        original_format: 'rst'
      });
      
      markdownFiles.push({
        path: rstFile,
        content: contentWithMeta,
        relativePath
      });
      
      console.log(`  ✓ Converted: ${relativePath}`);
    } catch (error) {
      console.error(`  ✗ Failed to convert ${rstFile}:`, error);
      // Continue with other files
    }
  }
  
  return markdownFiles;
}
```

**File: `packages/ingestion/src/upload-s3.ts`**

```typescript
import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';
import { Upload } from '@aws-sdk/lib-storage';
import { MarkdownFile } from './convert-rst.js';

const s3Client = new S3Client({});

export async function uploadToS3(
  files: MarkdownFile[],
  bucketName: string,
  prefix: string
): Promise<void> {
  console.log(`Uploading ${files.length} files to s3://${bucketName}/${prefix}`);
  
  const uploads = files.map(async (file) => {
    const key = `${prefix}${file.relativePath}`;
    
    try {
      await s3Client.send(new PutObjectCommand({
        Bucket: bucketName,
        Key: key,
        Body: file.content,
        ContentType: 'text/markdown',
        Metadata: {
          'source-file': file.path,
          'format': 'markdown'
        }
      }));
      
      console.log(`  ✓ Uploaded: ${key}`);
    } catch (error) {
      console.error(`  ✗ Failed to upload ${key}:`, error);
      throw error;
    }
  });
  
  await Promise.all(uploads);
}
```

## Phase 3: MCP Server Functions

### 3.1 Setup Functions Package

```bash
cd packages/functions

# Create package.json
cat > package.json << 'EOF'
{
  "name": "@smithy-mcp/functions",
  "version": "1.0.0",
  "private": true,
  "scripts": {
    "build": "tsc"
  },
  "dependencies": {
    "@aws-sdk/client-bedrock-agent-runtime": "^3.x.x",
    "@aws-sdk/client-s3": "^3.x.x",
    "@modelcontextprotocol/sdk": "^0.5.0"
  },
  "devDependencies": {
    "@types/node": "^20.x.x",
    "@types/aws-lambda": "^8.x.x",
    "typescript": "^5.3.0"
  }
}
EOF

# Create tsconfig
cat > tsconfig.json << 'EOF'
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "commonjs",
    "lib": ["ES2022"],
    "outDir": "./dist",
    "rootDir": "./src",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "forceConsistentCasingInFileNames": true,
    "resolveJsonModule": true,
    "moduleResolution": "node"
  },
  "include": ["src/**/*"],
  "exclude": ["node_modules", "dist"]
}
EOF

pnpm install
```

### 3.2 Create Common Types

**File: `packages/functions/src/common/types.ts`**

```typescript
export interface SearchResult {
  content: string;
  location: {
    s3Uri: string;
    type: 'S3';
  };
  score: number;
  metadata?: Record<string, any>;
}

export interface DocumentContent {
  content: string;
  metadata: {
    source: string;
    title?: string;
    [key: string]: any;
  };
}

export interface MCPToolCall {
  name: string;
  arguments: Record<string, any>;
}

export interface MCPToolResponse {
  content: Array<{
    type: 'text';
    text: string;
  }>;
  isError?: boolean;
}
```

### 3.3 Create Bedrock Client

**File: `packages/functions/src/mcp-server/bedrock-client.ts`**

```typescript
import {
  BedrockAgentRuntimeClient,
  RetrieveCommand,
  RetrieveCommandInput,
} from '@aws-sdk/client-bedrock-agent-runtime';
import { SearchResult } from '../common/types.js';

const client = new BedrockAgentRuntimeClient({});

const KNOWLEDGE_BASE_ID = process.env.KNOWLEDGE_BASE_ID!;

export async function searchKnowledgeBase(
  query: string,
  maxResults: number = 5
): Promise<SearchResult[]> {
  const input: RetrieveCommandInput = {
    knowledgeBaseId: KNOWLEDGE_BASE_ID,
    retrievalQuery: {
      text: query,
    },
    retrievalConfiguration: {
      vectorSearchConfiguration: {
        numberOfResults: maxResults,
      },
    },
  };

  try {
    const command = new RetrieveCommand(input);
    const response = await client.send(command);

    return (response.retrievalResults || []).map((result) => ({
      content: result.content?.text || '',
      location: {
        s3Uri: result.location?.s3Location?.uri || '',
        type: 'S3' as const,
      },
      score: result.score || 0,
      metadata: result.metadata,
    }));
  } catch (error) {
    console.error('Error searching knowledge base:', error);
    throw error;
  }
}
```

### 3.4 Create MCP Tools

**File: `packages/functions/src/mcp-server/tools/search.ts`**

```typescript
import { searchKnowledgeBase } from '../bedrock-client.js';
import { MCPToolResponse } from '../../common/types.js';

export const searchToolDefinition = {
  name: 'search_smithy_docs',
  description: 
    'Search the Smithy CLI documentation using semantic search. ' +
    'Returns relevant documentation snippets with their source locations. ' +
    'Use this to find information about Smithy features, syntax, guides, and specifications.',
  inputSchema: {
    type: 'object',
    properties: {
      query: {
        type: 'string',
        description: 'The search query. Can be a question or keywords.',
      },
      max_results: {
        type: 'number',
        description: 'Maximum number of results to return (1-10)',
        default: 5,
        minimum: 1,
        maximum: 10,
      },
    },
    required: ['query'],
  },
};

export async function handleSearchTool(
  args: { query: string; max_results?: number }
): Promise<MCPToolResponse> {
  try {
    const maxResults = Math.min(args.max_results || 5, 10);
    const results = await searchKnowledgeBase(args.query, maxResults);

    if (results.length === 0) {
      return {
        content: [
          {
            type: 'text',
            text: 'No relevant documentation found for your query. Try rephrasing or using different keywords.',
          },
        ],
      };
    }

    // Format results as markdown
    let response = `# Search Results for: "${args.query}"\n\n`;
    response += `Found ${results.length} relevant section(s):\n\n`;

    results.forEach((result, index) => {
      const fileName = result.location.s3Uri.split('/').pop() || 'unknown';
      response += `## Result ${index + 1} (Score: ${result.score.toFixed(3)})\n`;
      response += `**Source:** \`${fileName}\`\n\n`;
      response += `${result.content}\n\n`;
      response += '---\n\n';
    });

    return {
      content: [
        {
          type: 'text',
          text: response,
        },
      ],
    };
  } catch (error) {
    console.error('Error in search tool:', error);
    return {
      content: [
        {
          type: 'text',
          text: `Error searching documentation: ${error instanceof Error ? error.message : 'Unknown error'}`,
        },
      ],
      isError: true,
    };
  }
}
```

**File: `packages/functions/src/mcp-server/tools/read.ts`**

```typescript
import { S3Client, GetObjectCommand } from '@aws-sdk/client-s3';
import { MCPToolResponse } from '../../common/types.js';

const s3Client = new S3Client({});
const BUCKET_NAME = process.env.BUCKET_NAME!;

export const readToolDefinition = {
  name: 'read_smithy_doc',
  description:
    'Read the full content of a specific Smithy documentation file. ' +
    'Use this after searching to get the complete context of a documentation page.',
  inputSchema: {
    type: 'object',
    properties: {
      file_path: {
        type: 'string',
        description: 'The relative path to the documentation file (e.g., "quickstart.md" or "guides/model-basics.md")',
      },
    },
    required: ['file_path'],
  },
};

export async function handleReadTool(
  args: { file_path: string }
): Promise<MCPToolResponse> {
  try {
    // Ensure path doesn't start with slash
    const cleanPath = args.file_path.replace(/^\/+/, '');
    const key = `smithy-docs/${cleanPath}`;

    const command = new GetObjectCommand({
      Bucket: BUCKET_NAME,
      Key: key,
    });

    const response = await s3Client.send(command);
    const content = await response.Body?.transformToString();

    if (!content) {
      return {
        content: [
          {
            type: 'text',
            text: `Document found but content is empty: ${args.file_path}`,
          },
        ],
        isError: true,
      };
    }

    return {
      content: [
        {
          type: 'text',
          text: `# ${args.file_path}\n\n${content}`,
        },
      ],
    };
  } catch (error: any) {
    if (error.name === 'NoSuchKey') {
      return {
        content: [
          {
            type: 'text',
            text: `Document not found: ${args.file_path}\n\nTip: Use search_smithy_docs to find available documents.`,
          },
        ],
        isError: true,
      };
    }

    console.error('Error reading document:', error);
    return {
      content: [
        {
          type: 'text',
          text: `Error reading document: ${error instanceof Error ? error.message : 'Unknown error'}`,
        },
      ],
      isError: true,
    };
  }
}
```

**File: `packages/functions/src/mcp-server/tools/list.ts`**

```typescript
import { S3Client, ListObjectsV2Command } from '@aws-sdk/client-s3';
import { MCPToolResponse } from '../../common/types.js';

const s3Client = new S3Client({});
const BUCKET_NAME = process.env.BUCKET_NAME!;
const PREFIX = 'smithy-docs/';

export const listToolDefinition = {
  name: 'list_smithy_topics',
  description:
    'List all available Smithy documentation topics and files. ' +
    'Returns a structured view of the documentation hierarchy.',
  inputSchema: {
    type: 'object',
    properties: {},
    required: [],
  },
};

export async function handleListTool(): Promise<MCPToolResponse> {
  try {
    const command = new ListObjectsV2Command({
      Bucket: BUCKET_NAME,
      Prefix: PREFIX,
    });

    const response = await s3Client.send(command);
    const files = response.Contents || [];

    if (files.length === 0) {
      return {
        content: [
          {
            type: 'text',
            text: 'No documentation files found. The knowledge base may not be populated yet.',
          },
        ],
      };
    }

    // Organize files by directory
    const fileTree: Record<string, string[]> = {};
    
    files.forEach((file) => {
      if (!file.Key) return;
      
      const relativePath = file.Key.replace(PREFIX, '');
      const parts = relativePath.split('/');
      
      if (parts.length === 1) {
        // Root level file
        if (!fileTree['Root']) fileTree['Root'] = [];
        fileTree['Root'].push(relativePath);
      } else {
        // File in subdirectory
        const dir = parts.slice(0, -1).join('/');
        if (!fileTree[dir]) fileTree[dir] = [];
        fileTree[dir].push(relativePath);
      }
    });

    // Format as markdown
    let response = '# Smithy Documentation Files\n\n';
    response += `Total files: ${files.length}\n\n`;

    // Sort directories
    const sortedDirs = Object.keys(fileTree).sort();

    sortedDirs.forEach((dir) => {
      response += `## ${dir}\n\n`;
      fileTree[dir].forEach((file) => {
        response += `- \`${file}\`\n`;
      });
      response += '\n';
    });

    return {
      content: [
        {
          type: 'text',
          text: response,
        },
      ],
    };
  } catch (error) {
    console.error('Error listing topics:', error);
    return {
      content: [
        {
          type: 'text',
          text: `Error listing topics: ${error instanceof Error ? error.message : 'Unknown error'}`,
        },
      ],
      isError: true,
    };
  }
}
```

### 3.5 Create Main MCP Server Handler

**File: `packages/functions/src/mcp-server/index.ts`**

```typescript
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';

import { searchToolDefinition, handleSearchTool } from './tools/search.js';
import { readToolDefinition, handleReadTool } from './tools/read.js';
import { listToolDefinition, handleListTool } from './tools/list.js';

// For Lambda, we need to handle HTTP requests
// This is a simplified version - you may want to use the MCP HTTP transport
export const handler = async (event: any) => {
  // Parse the MCP request from the Lambda event
  const mcpRequest = JSON.parse(event.body || '{}');

  // Route based on method
  if (mcpRequest.method === 'tools/list') {
    return {
      statusCode: 200,
      headers: {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*',
      },
      body: JSON.stringify({
        tools: [
          searchToolDefinition,
          readToolDefinition,
          listToolDefinition,
        ],
      }),
    };
  }

  if (mcpRequest.method === 'tools/call') {
    const { name, arguments: args } = mcpRequest.params;

    let result;
    switch (name) {
      case 'search_smithy_docs':
        result = await handleSearchTool(args);
        break;
      case 'read_smithy_doc':
        result = await handleReadTool(args);
        break;
      case 'list_smithy_topics':
        result = await handleListTool();
        break;
      default:
        return {
          statusCode: 400,
          body: JSON.stringify({ error: `Unknown tool: ${name}` }),
        };
    }

    return {
      statusCode: 200,
      headers: {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*',
      },
      body: JSON.stringify(result),
    };
  }

  // Handle server info request
  if (mcpRequest.method === 'initialize') {
    return {
      statusCode: 200,
      headers: {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*',
      },
      body: JSON.stringify({
        protocolVersion: '2024-11-05',
        capabilities: {
          tools: {},
        },
        serverInfo: {
          name: 'smithy-docs-mcp-server',
          version: '1.0.0',
        },
      }),
    };
  }

  return {
    statusCode: 400,
    body: JSON.stringify({ error: 'Invalid request' }),
  };
};
```

## Phase 4: CDK Infrastructure

### 4.1 Setup CDK Package

```bash
cd packages/cdk

# Create package.json
cat > package.json << 'EOF'
{
  "name": "@smithy-mcp/cdk",
  "version": "1.0.0",
  "private": true,
  "scripts": {
    "build": "tsc",
    "synth": "cdk synth",
    "deploy": "cdk deploy --all",
    "destroy": "cdk destroy --all"
  },
  "dependencies": {
    "aws-cdk-lib": "^2.x.x",
    "constructs": "^10.x.x"
  },
  "devDependencies": {
    "@types/node": "^20.x.x",
    "aws-cdk": "^2.x.x",
    "typescript": "^5.3.0"
  }
}
EOF

# Create CDK config
cat > cdk.json << 'EOF'
{
  "app": "node dist/bin/app.js",
  "context": {
    "@aws-cdk/core:enableStackNameDuplicates": false,
    "@aws-cdk/core:stackRelativeExports": true
  }
}
EOF

# Create tsconfig
cat > tsconfig.json << 'EOF'
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "commonjs",
    "lib": ["ES2022"],
    "outDir": "./dist",
    "rootDir": ".",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "forceConsistentCasingInFileNames": true,
    "resolveJsonModule": true
  },
  "include": ["bin/**/*", "lib/**/*"],
  "exclude": ["node_modules", "dist"]
}
EOF

mkdir -p bin lib
pnpm install
```

### 4.2 CDK App Entry Point

**File: `packages/cdk/bin/app.ts`**

```typescript
#!/usr/bin/env node
import 'source-map-support/register';
import * as cdk from 'aws-cdk-lib';
import { SmithyKnowledgeBaseStack } from '../lib/smithy-knowledge-base-stack';
import { SmithyMcpServerStack } from '../lib/smithy-mcp-server-stack';

const app = new cdk.App();

// Stack 1: Knowledge Base Infrastructure
const kbStack = new SmithyKnowledgeBaseStack(app, 'SmithyKnowledgeBaseStack', {
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: process.env.CDK_DEFAULT_REGION,
  },
  description: 'S3 bucket and Bedrock Knowledge Base for Smithy documentation',
});

// Stack 2: MCP Server
const mcpStack = new SmithyMcpServerStack(app, 'SmithyMcpServerStack', {
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: process.env.CDK_DEFAULT_REGION,
  },
  description: 'MCP Server Lambda function with public endpoint',
  bucket: kbStack.bucket,
  knowledgeBaseId: kbStack.knowledgeBaseId,
});

app.synth();
```

### 4.3 Knowledge Base Stack

**File: `packages/cdk/lib/smithy-knowledge-base-stack.ts`**

```typescript
import * as cdk from 'aws-cdk-lib';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as bedrock from 'aws-cdk-lib/aws-bedrock';
import { Construct } from 'constructs';

export class SmithyKnowledgeBaseStack extends cdk.Stack {
  public readonly bucket: s3.IBucket;
  public readonly knowledgeBaseId: string;

  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    // S3 Bucket for documentation storage
    this.bucket = new s3.Bucket(this, 'SmithyDocsBucket', {
      bucketName: `smithy-docs-${this.account}-${this.region}`,
      versioned: true,
      encryption: s3.BucketEncryption.S3_MANAGED,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      removalPolicy: cdk.RemovalPolicy.RETAIN, // Keep docs on stack deletion
      autoDeleteObjects: false,
    });

    // IAM Role for Bedrock Knowledge Base
    const kbRole = new iam.Role(this, 'KnowledgeBaseRole', {
      assumedBy: new iam.ServicePrincipal('bedrock.amazonaws.com'),
      description: 'Role for Bedrock Knowledge Base to access S3',
    });

    // Grant read access to S3 bucket
    this.bucket.grantRead(kbRole);

    // Grant Bedrock model invocation for embeddings
    kbRole.addToPolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: ['bedrock:InvokeModel'],
        resources: [
          `arn:aws:bedrock:${this.region}::foundation-model/amazon.titan-embed-text-v2:0`,
        ],
      })
    );

    // Create Knowledge Base
    const knowledgeBase = new bedrock.CfnKnowledgeBase(this, 'SmithyKnowledgeBase', {
      name: 'smithy-docs-kb',
      description: 'Smithy CLI Documentation Knowledge Base',
      roleArn: kbRole.roleArn,
      knowledgeBaseConfiguration: {
        type: 'VECTOR',
        vectorKnowledgeBaseConfiguration: {
          embeddingModelArn: `arn:aws:bedrock:${this.region}::foundation-model/amazon.titan-embed-text-v2:0`,
        },
      },
      storageConfiguration: {
        type: 'OPENSEARCH_SERVERLESS',
        opensearchServerlessConfiguration: {
          collectionArn: this.createOpenSearchCollection(),
          vectorIndexName: 'smithy-docs-index',
          fieldMapping: {
            vectorField: 'vector',
            textField: 'text',
            metadataField: 'metadata',
          },
        },
      },
    });

    // Data Source for S3
    const dataSource = new bedrock.CfnDataSource(this, 'SmithyDocsDataSource', {
      knowledgeBaseId: knowledgeBase.attrKnowledgeBaseId,
      name: 'smithy-docs-s3-source',
      dataSourceConfiguration: {
        type: 'S3',
        s3Configuration: {
          bucketArn: this.bucket.bucketArn,
          inclusionPrefixes: ['smithy-docs/'],
        },
      },
    });

    this.knowledgeBaseId = knowledgeBase.attrKnowledgeBaseId;

    // Outputs
    new cdk.CfnOutput(this, 'BucketName', {
      value: this.bucket.bucketName,
      description: 'S3 bucket for Smithy documentation',
      exportName: 'SmithyDocsBucketName',
    });

    new cdk.CfnOutput(this, 'KnowledgeBaseId', {
      value: this.knowledgeBaseId,
      description: 'Bedrock Knowledge Base ID',
      exportName: 'SmithyKnowledgeBaseId',
    });
  }

  private createOpenSearchCollection(): string {
    // Note: OpenSearch Serverless requires additional setup
    // This is a simplified version - you'll need to create the collection
    // separately or use a custom resource
    
    // For now, return a placeholder that you'll need to replace
    // with your actual OpenSearch Serverless collection ARN
    return `arn:aws:aoss:${this.region}:${this.account}:collection/smithy-docs-collection`;
    
    // TODO: Add custom resource to create OpenSearch Serverless collection
    // or create it manually and reference it here
  }
}
```

### 4.4 MCP Server Stack

**File: `packages/cdk/lib/smithy-mcp-server-stack.ts`**

```typescript
import * as cdk from 'aws-cdk-lib';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as lambdaNodejs from 'aws-cdk-lib/aws-lambda-nodejs';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as s3 from 'aws-cdk-lib/aws-s3';
import { Construct } from 'constructs';
import * as path from 'path';

interface SmithyMcpServerStackProps extends cdk.StackProps {
  bucket: s3.IBucket;
  knowledgeBaseId: string;
}

export class SmithyMcpServerStack extends cdk.Stack {
  public readonly functionUrl: string;

  constructor(scope: Construct, id: string, props: SmithyMcpServerStackProps) {
    super(scope, id, props);

    // Lambda function for MCP server
    const mcpFunction = new lambdaNodejs.NodejsFunction(this, 'McpServerFunction', {
      entry: path.join(__dirname, '../../functions/src/mcp-server/index.ts'),
      handler: 'handler',
      runtime: lambda.Runtime.NODEJS_20_X,
      timeout: cdk.Duration.seconds(30),
      memorySize: 512,
      environment: {
        KNOWLEDGE_BASE_ID: props.knowledgeBaseId,
        BUCKET_NAME: props.bucket.bucketName,
        NODE_ENV: 'production',
      },
      bundling: {
        minify: true,
        sourceMap: true,
        externalModules: ['@aws-sdk/*'], // AWS SDK v3 is provided by Lambda
      },
    });

    // Grant permissions
    props.bucket.grantRead(mcpFunction);

    mcpFunction.addToRolePolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: [
          'bedrock:Retrieve',
          'bedrock:RetrieveAndGenerate',
        ],
        resources: [
          `arn:aws:bedrock:${this.region}:${this.account}:knowledge-base/${props.knowledgeBaseId}`,
        ],
      })
    );

    mcpFunction.addToRolePolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: ['bedrock:InvokeModel'],
        resources: [
          `arn:aws:bedrock:${this.region}::foundation-model/amazon.titan-embed-text-v2:0`,
        ],
      })
    );

    // Create Function URL (public endpoint)
    const functionUrl = mcpFunction.addFunctionUrl({
      authType: lambda.FunctionUrlAuthType.NONE, // Public access
      cors: {
        allowedOrigins: ['*'],
        allowedMethods: [lambda.HttpMethod.ALL],
        allowedHeaders: ['*'],
      },
    });

    this.functionUrl = functionUrl.url;

    // Outputs
    new cdk.CfnOutput(this, 'McpServerUrl', {
      value: this.functionUrl,
      description: 'Public URL for MCP server',
      exportName: 'SmithyMcpServerUrl',
    });

    new cdk.CfnOutput(this, 'FunctionName', {
      value: mcpFunction.functionName,
      description: 'Lambda function name',
    });
  }
}
```

## Phase 5: Deployment & Usage

### 5.1 Deploy Infrastructure

```bash
# From project root
cd packages/cdk

# Bootstrap CDK (first time only)
pnpm cdk bootstrap

# Build all packages
cd ../..
pnpm build

# Deploy stacks
cd packages/cdk
pnpm deploy

# Note the outputs:
# - SmithyDocsBucketName
# - SmithyKnowledgeBaseId  
# - SmithyMcpServerUrl
```

### 5.2 Run Ingestion

```bash
# Set environment variables from CDK outputs
export BUCKET_NAME=<SmithyDocsBucketName>

# Run ingestion script
cd packages/ingestion
pnpm build
pnpm start
```

### 5.3 Sync Knowledge Base

After ingestion completes, you need to manually trigger a Knowledge Base sync:

```bash
# Using AWS CLI
aws bedrock-agent start-ingestion-job \
  --knowledge-base-id <SmithyKnowledgeBaseId> \
  --data-source-id <DataSourceId>

# Or via AWS Console:
# 1. Go to Amazon Bedrock > Knowledge bases
# 2. Select your knowledge base
# 3. Click "Sync" on the data source
```

Wait 5-10 minutes for the sync to complete.

### 5.4 Test the MCP Server

#### Using curl:

```bash
# List tools
curl -X POST <SmithyMcpServerUrl> \
  -H "Content-Type: application/json" \
  -d '{
    "jsonrpc": "2.0",
    "method": "tools/list",
    "id": 1
  }'

# Search docs
curl -X POST <SmithyMcpServerUrl> \
  -H "Content-Type: application/json" \
  -d '{
    "jsonrpc": "2.0",
    "method": "tools/call",
    "params": {
      "name": "search_smithy_docs",
      "arguments": {
        "query": "How do I define a service in Smithy?"
      }
    },
    "id": 2
  }'
```

#### Using with Claude Desktop:

Add to your Claude Desktop config (`~/Library/Application Support/Claude/claude_desktop_config.json` on macOS):

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

Then restart Claude Desktop and you can ask questions like:
- "Search the Smithy docs for service definitions"
- "How do I use Smithy traits?"
- "Show me Smithy model examples"

### 5.5 Using with AI Agents

```python
# Example with LangChain or similar
import requests

def search_smithy_docs(query: str):
    response = requests.post(
        "<SmithyMcpServerUrl>",
        json={
            "jsonrpc": "2.0",
            "method": "tools/call",
            "params": {
                "name": "search_smithy_docs",
                "arguments": {"query": query}
            },
            "id": 1
        }
    )
    return response.json()

result = search_smithy_docs("Smithy model validation")
print(result)
```

## Phase 6: Monitoring & Maintenance

### 6.1 CloudWatch Logs

```bash
# View Lambda logs
aws logs tail /aws/lambda/<FunctionName> --follow

# Filter for errors
aws logs filter-events \
  --log-group-name /aws/lambda/<FunctionName> \
  --filter-pattern "ERROR"
```

### 6.2 Update Documentation

To update the documentation:

```bash
# Re-run ingestion
cd packages/ingestion
pnpm start

# Trigger Knowledge Base sync
aws bedrock-agent start-ingestion-job \
  --knowledge-base-id <SmithyKnowledgeBaseId> \
  --data-source-id <DataSourceId>
```

### 6.3 Cost Monitoring

```bash
# View cost estimates
aws ce get-cost-and-usage \
  --time-period Start=2024-01-01,End=2024-01-31 \
  --granularity MONTHLY \
  --metrics UnblendedCost \
  --filter file://cost-filter.json
```

## Troubleshooting

### Issue: Knowledge Base sync fails

**Solution:** Check IAM permissions. The Knowledge Base role needs:
- `s3:GetObject` on your bucket
- `bedrock:InvokeModel` for the embedding model

### Issue: Lambda timeout

**Solution:** Increase timeout in CDK stack:
```typescript
timeout: cdk.Duration.seconds(60), // Increase from 30
```

### Issue: No search results

**Solution:** 
1. Verify files uploaded to S3
2. Check Knowledge Base sync status
3. Try broader search terms

### Issue: CORS errors

**Solution:** Verify Function URL CORS settings in CDK:
```typescript
cors: {
  allowedOrigins: ['*'],
  allowedMethods: [lambda.HttpMethod.ALL],
  allowedHeaders: ['*'],
}
```

## Next Steps & Enhancements

1. **Add authentication:** Implement API key or IAM auth
2. **Add caching:** Use ElastiCache for frequent queries
3. **Scheduled updates:** EventBridge rule to auto-sync daily
4. **Metrics dashboard:** CloudWatch dashboard for usage stats
5. **Rate limiting:** API Gateway with throttling
6. **Multi-region:** Deploy to multiple regions for lower latency
7. **Custom chunking:** Improve chunking strategy for better search
8. **Feedback loop:** Collect search queries to improve docs

## Cost Estimate (Monthly)

- **S3 Storage:** $0.023/GB (~$0.50 for 20GB)
- **Bedrock Embeddings:** $0.0001 per 1K tokens (~$2 for initial ingestion)
- **Bedrock Retrieval:** $0.00004 per query (~$2 for 50K queries)
- **Lambda:** $0.20 per 1M requests (~$0.40 for 2M requests)
- **OpenSearch Serverless:** ~$700/month (minimum)
- **Data Transfer:** Minimal

**Total estimated cost:** ~$705-710/month

**Note:** OpenSearch Serverless is the main cost driver. For lower costs, consider using a self-managed solution or Aurora with pgvector.

## References

- [Smithy Documentation](https://smithy.io/2.0/)
- [MCP SDK Documentation](https://modelcontextprotocol.io/)
- [AWS Bedrock Knowledge Bases](https://docs.aws.amazon.com/bedrock/latest/userguide/knowledge-base.html)
- [AWS CDK Documentation](https://docs.aws.amazon.com/cdk/)
