import { type AddressInfo } from 'node:net';
import http, { type IncomingHttpHeaders, type Server } from 'node:http';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createApp, readDocumentBody, type RuntimeServices } from '../src/mcp-server/index';
import {
  MAX_REQUEST_BODY_BYTES,
  MAX_TOOL_OUTPUT_BYTES,
  type RuntimeConfig
} from '../src/mcp-server/runtime';

interface TestResponse {
  status: number;
  headers: IncomingHttpHeaders;
  body: string;
}

function request(
  server: Server,
  body: string,
  headers: Record<string, string> = {}
): Promise<TestResponse> {
  const address = server.address() as AddressInfo;
  return new Promise((resolve, reject) => {
    const outgoing = http.request(
      {
        hostname: '127.0.0.1',
        port: address.port,
        path: '/mcp',
        method: 'POST',
        headers: {
          host: 'mcp.example.com',
          origin: 'https://app.example.com',
          'content-type': 'application/json',
          accept: 'application/json, text/event-stream',
          'content-length': Buffer.byteLength(body).toString(),
          ...headers
        }
      },
      response => {
        const chunks: Buffer[] = [];
        response.on('data', chunk => chunks.push(Buffer.from(chunk)));
        response.on('end', () =>
          resolve({
            status: response.statusCode || 0,
            headers: response.headers,
            body: Buffer.concat(chunks).toString('utf8')
          })
        );
      }
    );
    outgoing.on('error', reject);
    outgoing.end(body);
  });
}

const config: RuntimeConfig = {
  bucketName: 'test-bucket',
  knowledgeBaseId: 'test-knowledge-base',
  resourceRegion: 'us-west-2',
  allowedHosts: ['mcp.example.com'],
  allowedOrigins: ['https://app.example.com'],
  port: 8080
};

const loadDocumentPage = vi.fn(async () => ({ keys: [] as Array<string | undefined> }));

const services: RuntimeServices = {
  search: vi.fn(async () => [
    {
      content: 'x'.repeat(MAX_TOOL_OUTPUT_BYTES * 2),
      location: { s3Uri: 's3://test-bucket/smithy-docs/large.md', type: 'S3' },
      score: 0.9
    }
  ]),
  getDocument: vi.fn(async () => undefined),
  loadDocumentPage
};

describe('MCP HTTP server', () => {
  let server: Server;

  beforeAll(() => {
    server = createApp(config, services).listen(0);
  });

  afterAll(async () => {
    await new Promise<void>((resolve, reject) => {
      server.close(error => (error ? reject(error) : resolve()));
    });
  });

  it('handles independent Streamable HTTP initialization requests', async () => {
    const initialize = (id: number) =>
      JSON.stringify({
        jsonrpc: '2.0',
        id,
        method: 'initialize',
        params: {
          protocolVersion: '2025-03-26',
          capabilities: {},
          clientInfo: { name: 'unit-test', version: '1.0.0' }
        }
      });

    const first = await request(server, initialize(1));
    const second = await request(server, initialize(2));

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(JSON.parse(first.body).result.serverInfo.name).toBe('smithy-docs-mcp-server');
    expect(JSON.parse(second.body).result.serverInfo.name).toBe('smithy-docs-mcp-server');
    expect(first.headers['mcp-session-id']).toBeUndefined();
    expect(second.headers['mcp-session-id']).toBeUndefined();
  });

  it('rejects unconfigured hosts and origins before handling MCP', async () => {
    const payload = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping' });
    const badHost = await request(server, payload, { host: 'attacker.example' });
    const badOrigin = await request(server, payload, {
      origin: 'https://attacker.example'
    });

    expect(badHost.status).toBe(403);
    expect(JSON.parse(badHost.body).error.message).toBe('Request host or origin is not allowed');
    expect(badOrigin.status).toBe(403);
  });

  it('accepts the CloudFront-pinned viewer host over the adapter origin host', async () => {
    const payload = JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'ping' });
    const response = await request(server, payload, {
      host: 'generated.lambda-url.us-east-1.on.aws',
      'x-mcp-forwarded-host': 'mcp.example.com'
    });

    expect(response.status, response.body).toBe(200);
  });

  it('returns a safe error for oversized bodies', async () => {
    const oversized = JSON.stringify({ data: 'x'.repeat(MAX_REQUEST_BODY_BYTES) });
    const response = await request(server, oversized);

    expect(response.status).toBe(413);
    expect(JSON.parse(response.body).error.message).toBe('Request body is too large');
    expect(response.body).not.toContain('PayloadTooLargeError');
  });

  it('bounds tool results without requiring AWS clients', async () => {
    const response = await request(
      server,
      JSON.stringify({
        jsonrpc: '2.0',
        id: 3,
        method: 'tools/call',
        params: {
          name: 'search_smithy_docs',
          arguments: { query: 'large result', max_results: 1 }
        }
      })
    );

    expect(response.status).toBe(200);
    const text = JSON.parse(response.body).result.content[0].text as string;
    expect(Buffer.byteLength(text, 'utf8')).toBeLessThanOrEqual(MAX_TOOL_OUTPUT_BYTES);
    expect(text).toContain('[Output truncated');
  });

  it('lists complete sorted paths with truthful included and discovered counts', async () => {
    loadDocumentPage.mockResolvedValueOnce({
      keys: [
        `smithy-docs/z-${'x'.repeat(1_000)}.md`,
        'smithy-docs/b.md',
        'smithy-docs/',
        'smithy-docs/a.md'
      ]
    });

    const response = await request(
      server,
      JSON.stringify({
        jsonrpc: '2.0',
        id: 4,
        method: 'tools/call',
        params: { name: 'list_smithy_topics', arguments: {} }
      })
    );

    expect(response.status).toBe(200);
    const text = JSON.parse(response.body).result.content[0].text as string;
    expect(text).toContain('Included: 3 of 3 discovered files');
    expect(text.indexOf('- a.md')).toBeLessThan(text.indexOf('- b.md'));
    expect(text.indexOf('- b.md')).toBeLessThan(text.indexOf('- z-'));
    expect((text.match(/^- /gm) ?? []).length).toBe(3);
    expect(Buffer.byteLength(text, 'utf8')).toBeLessThanOrEqual(MAX_TOOL_OUTPUT_BYTES);
  });
});

describe('document stream bounding', () => {
  async function* body(...chunks: string[]) {
    for (const chunk of chunks) {
      yield Buffer.from(chunk);
    }
  }

  it('does not mark an exact-size document as truncated', async () => {
    await expect(readDocumentBody(body('1234'), 4)).resolves.toEqual({
      text: '1234',
      truncated: false
    });
  });

  it('uses a one-byte lookahead to detect oversized documents', async () => {
    await expect(readDocumentBody(body('1234', '5'), 4)).resolves.toEqual({
      text: '1234',
      truncated: true
    });
  });
});
