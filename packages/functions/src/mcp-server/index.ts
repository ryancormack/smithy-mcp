import express from 'express';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { z } from 'zod';
import { searchKnowledgeBase } from './bedrock-client.js';
import { S3Client, GetObjectCommand, ListObjectsV2Command } from '@aws-sdk/client-s3';

const s3Client = new S3Client({});
const BUCKET_NAME = process.env.BUCKET_NAME!;

const server = new McpServer({
  name: 'smithy-docs-mcp-server',
  version: '1.0.0'
});

server.registerTool(
  'search_smithy_docs',
  {
    title: 'Search Smithy Documentation',
    description: 'Search the Smithy CLI documentation using semantic search',
    inputSchema: {
      query: z.string(),
      max_results: z.number().min(1).max(10).optional().default(5)
    }
  },
  async ({ query, max_results }) => {
    const results = await searchKnowledgeBase(query, max_results);
    
    if (results.length === 0) {
      return {
        content: [{ type: 'text', text: 'No relevant documentation found' }]
      };
    }

    let response = `# Search Results: "${query}"\n\n`;
    results.forEach((result, i) => {
      const fileName = result.location.s3Uri.split('/').pop() || 'unknown';
      response += `## Result ${i + 1} (${result.score.toFixed(3)})\n**Source:** ${fileName}\n\n${result.content}\n\n---\n\n`;
    });

    return { content: [{ type: 'text', text: response }] };
  }
);

server.registerTool(
  'read_smithy_doc',
  {
    title: 'Read Smithy Documentation',
    description: 'Read full content of a documentation file',
    inputSchema: {
      file_path: z.string()
    }
  },
  async ({ file_path }) => {
    const key = `smithy-docs/${file_path.replace(/^\/+/, '')}`;
    const response = await s3Client.send(new GetObjectCommand({ Bucket: BUCKET_NAME, Key: key }));
    const content = await response.Body?.transformToString();
    
    return {
      content: [{ type: 'text', text: `# ${file_path}\n\n${content}` }]
    };
  }
);

server.registerTool(
  'list_smithy_topics',
  {
    title: 'List Smithy Topics',
    description: 'List all available documentation files',
    inputSchema: {}
  },
  async () => {
    const response = await s3Client.send(new ListObjectsV2Command({ Bucket: BUCKET_NAME, Prefix: 'smithy-docs/' }));
    const files = (response.Contents || []).map(f => f.Key?.replace('smithy-docs/', '')).filter(Boolean);
    
    let result = `# Smithy Documentation\n\nTotal: ${files.length} files\n\n`;
    files.forEach(f => result += `- ${f}\n`);
    
    return { content: [{ type: 'text', text: result }] };
  }
);

const app = express();
app.use(express.json());

app.get('/', (req, res) => {
  res.send('Smithy MCP Server is running.');
});

app.post('/mcp', async (req, res) => {
  try {
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
      allowedHosts: ['*'],
      allowedOrigins: ['*']
    });

    res.on('close', () => {
      transport.close();
    });

    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  } catch (error) {
    console.error('Error handling MCP request:', error);
    if (!res.headersSent) {
      res.status(500).json({
        jsonrpc: '2.0',
        error: {
          code: -32603,
          message: 'Internal server error'
        },
        id: null
      });
    }
  }
});

const port = parseInt(process.env.PORT || '8080');
app.listen(port, () => {
  console.log(`MCP Server running on port ${port}`);
}).on('error', error => {
  console.error('Server error:', error);
  process.exit(1);
});
