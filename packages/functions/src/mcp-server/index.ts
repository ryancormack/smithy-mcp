import { Server as HttpServer } from 'node:http';
import express, { NextFunction, Request, Response } from 'express';
import { BedrockAgentRuntimeClient } from '@aws-sdk/client-bedrock-agent-runtime';
import {
  GetObjectCommand,
  ListObjectsV2Command,
  S3Client
} from '@aws-sdk/client-s3';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { z } from 'zod';
import { SearchResult } from '../common/types';
import { searchKnowledgeBase } from './bedrock-client';
import {
  boundUtf8Text,
  canonicalizeDocumentKey,
  collectPaginatedKeys,
  DOCUMENT_PREFIX,
  InvalidDocumentPathError,
  isRequestAllowed,
  loadRuntimeConfig,
  MAX_FILE_PATH_LENGTH,
  MAX_LISTED_DOCUMENTS,
  MAX_QUERY_LENGTH,
  MAX_REQUEST_BODY_BYTES,
  MAX_TOOL_OUTPUT_BYTES,
  ObjectPage,
  relativeDocumentPath,
  RuntimeConfig
} from './runtime';

export interface DocumentBody {
  [Symbol.asyncIterator]?: () => AsyncIterator<Uint8Array | string>;
  transformToByteArray?: () => Promise<Uint8Array>;
}

export interface RuntimeServices {
  search(query: string, maxResults: number): Promise<SearchResult[]>;
  getDocument(key: string): Promise<DocumentBody | undefined>;
  loadDocumentPage(continuationToken?: string): Promise<ObjectPage>;
}

interface HttpError extends Error {
  status?: number;
  type?: string;
}

function safeSourceName(uri: string): string {
  const source = uri.split('/').pop() || 'unknown';
  return source.replace(/[\u0000-\u001f\u007f]/g, '').slice(0, 256) || 'unknown';
}

export async function readDocumentBody(
  body: DocumentBody | undefined,
  maxBytes: number
): Promise<{ text: string; truncated: boolean }> {
  if (!body) {
    return { text: '', truncated: false };
  }

  const chunks: Buffer[] = [];
  let bytesRead = 0;
  let truncated = false;

  if (body[Symbol.asyncIterator]) {
    for await (const chunk of body as AsyncIterable<Uint8Array | string>) {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      const remaining = maxBytes - bytesRead;
      if (buffer.byteLength > remaining) {
        if (remaining > 0) {
          chunks.push(buffer.subarray(0, remaining));
        }
        truncated = true;
        break;
      }
      chunks.push(buffer);
      bytesRead += buffer.byteLength;
    }
  } else if (body.transformToByteArray) {
    const buffer = Buffer.from(await body.transformToByteArray());
    chunks.push(buffer.subarray(0, maxBytes));
    truncated = buffer.byteLength > maxBytes;
  }

  return { text: Buffer.concat(chunks).toString('utf8'), truncated };
}

function toolError(message: string) {
  return {
    content: [{ type: 'text' as const, text: message }],
    isError: true
  };
}

export function createMcpServer(
  config: RuntimeConfig,
  services: RuntimeServices
): McpServer {
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
        query: z.string().trim().min(1).max(MAX_QUERY_LENGTH),
        max_results: z.number().int().min(1).max(10).optional().default(5)
      }
    },
    async ({ query, max_results }) => {
      try {
        const results = (await services.search(query, max_results)).slice(0, max_results);
        if (results.length === 0) {
          return {
            content: [{ type: 'text', text: 'No relevant documentation found.' }]
          };
        }

        let response = `# Search Results: "${query}"\n\n`;
        results.forEach((result, index) => {
          response += `## Result ${index + 1} (${result.score.toFixed(3)})\n`;
          response += `**Source:** ${safeSourceName(result.location.s3Uri)}\n\n`;
          response += `${result.content}\n\n---\n\n`;
        });

        return {
          content: [{ type: 'text', text: boundUtf8Text(response) }]
        };
      } catch {
        return toolError('Unable to search the documentation right now.');
      }
    }
  );

  server.registerTool(
    'read_smithy_doc',
    {
      title: 'Read Smithy Documentation',
      description: 'Read the content of a documentation file',
      inputSchema: {
        file_path: z.string().trim().min(1).max(MAX_FILE_PATH_LENGTH)
      }
    },
    async ({ file_path }) => {
      let key: string;
      try {
        key = canonicalizeDocumentKey(file_path);
      } catch (error) {
        if (error instanceof InvalidDocumentPathError) {
          return toolError('Invalid document path. Use a relative path under smithy-docs/.');
        }
        return toolError('Unable to read the requested document.');
      }

      try {
        const heading = `# ${relativeDocumentPath(key) || 'Smithy document'}\n\n`;
        const contentBudget = MAX_TOOL_OUTPUT_BYTES - Buffer.byteLength(heading, 'utf8') - 128;
        const document = await readDocumentBody(
          await services.getDocument(key),
          contentBudget
        );
        if (!document.text) {
          return toolError('The requested document was not found or is empty.');
        }

        const truncation = document.truncated
          ? '\n\n[Document truncated to stay within the response limit.]'
          : '';
        return {
          content: [{
            type: 'text',
            text: boundUtf8Text(`${heading}${document.text}${truncation}`)
          }]
        };
      } catch {
        return toolError('Unable to read the requested document.');
      }
    }
  );

  server.registerTool(
    'list_smithy_topics',
    {
      title: 'List Smithy Topics',
      description: 'List available documentation files',
      inputSchema: {}
    },
    async () => {
      try {
        const result = await collectPaginatedKeys(
          services.loadDocumentPage,
          MAX_LISTED_DOCUMENTS
        );
        const files = result.keys
          .map(relativeDocumentPath)
          .filter((file): file is string => Boolean(file))
          .sort();

        let text = `# Smithy Documentation\n\nListed: ${files.length} files`;
        if (result.truncated) {
          text += ` (limited to ${MAX_LISTED_DOCUMENTS})`;
        }
        text += '\n\n';
        files.forEach(file => {
          text += `- ${file}\n`;
        });

        return {
          content: [{ type: 'text', text: boundUtf8Text(text) }]
        };
      } catch {
        return toolError('Unable to list documentation topics right now.');
      }
    }
  );

  return server;
}

export function createRuntimeServices(config: RuntimeConfig): RuntimeServices {
  const s3Client = new S3Client({ region: config.resourceRegion });
  const bedrockClient = new BedrockAgentRuntimeClient({ region: config.resourceRegion });

  return {
    search: (query, maxResults) => searchKnowledgeBase(
      bedrockClient,
      config.knowledgeBaseId,
      query,
      maxResults
    ),
    async getDocument(key) {
      const response = await s3Client.send(new GetObjectCommand({
        Bucket: config.bucketName,
        Key: key
      }));
      return response.Body;
    },
    async loadDocumentPage(continuationToken) {
      const response = await s3Client.send(new ListObjectsV2Command({
        Bucket: config.bucketName,
        Prefix: DOCUMENT_PREFIX,
        ContinuationToken: continuationToken
      }));
      return {
        keys: (response.Contents || []).map(item => item.Key),
        nextToken: response.NextContinuationToken
      };
    }
  };
}

function sendJsonRpcError(
  response: Response,
  status: number,
  code: number,
  message: string
): void {
  response.status(status).json({
    jsonrpc: '2.0',
    error: { code, message },
    id: null
  });
}

export function createApp(
  config: RuntimeConfig,
  services: RuntimeServices = createRuntimeServices(config)
): express.Express {
  const app = express();

  // CloudFront must use the Function URL hostname at the origin for TLS and
  // signing. Its OAC-protected origin overwrites this header with the viewer
  // domain so the existing MCP DNS-rebinding checks validate the public host.
  app.use((request, _response, next) => {
    const forwardedHost = request.get('x-mcp-forwarded-host');
    if (forwardedHost) {
      request.headers.host = forwardedHost;
    }
    next();
  });

  app.get('/', (_request, response) => {
    response.type('text/plain').send('Smithy MCP Server is running.');
  });

  app.post(
    '/mcp',
    (request: Request, response: Response, next: NextFunction) => {
      const allowed = isRequestAllowed(
        {
          host: request.get('host'),
          origin: request.get('origin')
        },
        config
      );
      if (!allowed) {
        sendJsonRpcError(response, 403, -32000, 'Request host or origin is not allowed');
        return;
      }
      next();
    },
    express.json({ limit: MAX_REQUEST_BODY_BYTES }),
    async (request: Request, response: Response) => {
      const server = createMcpServer(config, services);
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: undefined,
        enableJsonResponse: true,
        // Host/origin validation is performed by the Express middleware above,
        // after the OAC-pinned viewer host replaces the Lambda URL origin host.
        enableDnsRebindingProtection: false
      });
      let closed = false;
      const close = async () => {
        if (!closed) {
          closed = true;
          await transport.close();
        }
      };
      response.once('close', () => {
        void close();
      });

      try {
        await server.connect(transport);
        await transport.handleRequest(request, response, request.body);
      } catch {
        if (!response.headersSent) {
          sendJsonRpcError(response, 500, -32603, 'Internal server error');
        }
      } finally {
        if (response.writableEnded) {
          await close();
        }
      }
    }
  );

  app.use(
    (error: HttpError, _request: Request, response: Response, _next: NextFunction) => {
      if (response.headersSent) {
        return;
      }
      if (error.type === 'entity.too.large' || error.status === 413) {
        sendJsonRpcError(response, 413, -32600, 'Request body is too large');
        return;
      }
      sendJsonRpcError(response, 400, -32700, 'Invalid JSON request body');
    }
  );

  return app;
}

export function startServer(
  environment: NodeJS.ProcessEnv = process.env
): HttpServer {
  const config = loadRuntimeConfig(environment);
  const app = createApp(config);
  const httpServer = app.listen(config.port, () => {
    console.log(`MCP Server running on port ${config.port}`);
  });
  httpServer.on('error', () => {
    console.error('MCP Server failed to start');
    process.exitCode = 1;
  });
  return httpServer;
}

const isDirectExecution =
  typeof require !== 'undefined' &&
  typeof module !== 'undefined' &&
  require.main === module;
const isLambdaWebAdapterExecution =
  Boolean(process.env.AWS_LAMBDA_EXEC_WRAPPER) ||
  process.env.SMITHY_MCP_SERVER_AUTOSTART === 'true';

if (isDirectExecution || isLambdaWebAdapterExecution) {
  try {
    startServer();
  } catch {
    console.error('MCP Server configuration is invalid');
    process.exitCode = 1;
  }
}
