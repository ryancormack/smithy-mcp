#!/usr/bin/env node

const endpoint = process.env.MCP_SMOKE_URL?.trim();
const bearerToken = process.env.MCP_SMOKE_BEARER_TOKEN?.trim();
const protocolVersion = process.env.MCP_PROTOCOL_VERSION?.trim() || '2025-03-26';
const requireContent = process.env.MCP_SMOKE_REQUIRE_CONTENT?.trim() === 'true';
const attempts = Number(process.env.MCP_SMOKE_ATTEMPTS || '5');
const timeoutMs = Number(process.env.MCP_SMOKE_TIMEOUT_MS || '10000');
const maxResponseBytes = 1024 * 1024;

function configurationError(message) {
  console.error(`MCP smoke test configuration error: ${message}`);
  process.exit(2);
}

if (!endpoint) {
  configurationError('MCP_SMOKE_URL is required');
}

let url;
try {
  url = new URL(endpoint);
} catch {
  configurationError('MCP_SMOKE_URL must be a valid URL');
}
if (
  url.protocol !== 'https:' ||
  url.pathname !== '/mcp' ||
  url.username ||
  url.password ||
  url.search ||
  url.hash
) {
  configurationError('MCP_SMOKE_URL must be an HTTPS URL whose path is exactly /mcp');
}
if (!Number.isInteger(attempts) || attempts < 1 || attempts > 10) {
  configurationError('MCP_SMOKE_ATTEMPTS must be an integer from 1 through 10');
}
if (!Number.isInteger(timeoutMs) || timeoutMs < 1000 || timeoutMs > 60000) {
  configurationError('MCP_SMOKE_TIMEOUT_MS must be an integer from 1000 through 60000');
}
if (bearerToken && /[\r\n]/.test(bearerToken)) {
  configurationError('MCP_SMOKE_BEARER_TOKEN contains invalid characters');
}
if (
  process.env.MCP_SMOKE_REQUIRE_CONTENT !== undefined &&
  !['true', 'false'].includes(process.env.MCP_SMOKE_REQUIRE_CONTENT.trim())
) {
  configurationError('MCP_SMOKE_REQUIRE_CONTENT must be true or false');
}

async function readBoundedBody(body) {
  if (!body) {
    throw new Error('response body was empty');
  }
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let result = '';
  let bytes = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) {
      return result + decoder.decode();
    }
    bytes += value.byteLength;
    if (bytes > maxResponseBytes) {
      await reader.cancel();
      throw new Error('response exceeded the size limit');
    }
    result += decoder.decode(value, { stream: true });
  }
}

function parseJsonRpc(contentType, body) {
  if (contentType.includes('application/json')) {
    return JSON.parse(body);
  }
  if (contentType.includes('text/event-stream')) {
    const data = body
      .split(/\r?\n/)
      .filter(line => line.startsWith('data:'))
      .map(line => line.slice(5).trim())
      .find(Boolean);
    if (!data) {
      throw new Error('event stream did not contain JSON-RPC data');
    }
    return JSON.parse(data);
  }
  throw new Error('response content type was not MCP-compatible');
}

async function requestJsonRpc(payload) {
  const headers = {
    Accept: 'application/json, text/event-stream',
    'Content-Type': 'application/json'
  };
  if (bearerToken) {
    headers.Authorization = `Bearer ${bearerToken}`;
  }

  const response = await fetch(url, {
    method: 'POST',
    headers,
    body: JSON.stringify(payload),
    redirect: 'error',
    signal: AbortSignal.timeout(timeoutMs)
  });

  const contentLength = Number(response.headers.get('content-length') || '0');
  if (contentLength > maxResponseBytes) {
    await response.body?.cancel();
    throw new Error('response exceeded the size limit');
  }
  if (response.status !== 200) {
    await response.body?.cancel();
    throw new Error(`endpoint returned HTTP ${response.status}`);
  }

  const body = await readBoundedBody(response.body);
  const result = parseJsonRpc(response.headers.get('content-type') || '', body);
  if (result?.jsonrpc !== '2.0' || result.id !== payload.id || result.error) {
    throw new Error('response was not a successful JSON-RPC result');
  }
  return result;
}

function toolText(response, toolName) {
  const result = response?.result;
  const text = result?.content?.find(item => item?.type === 'text')?.text;
  if (result?.isError || typeof text !== 'string' || text.length === 0) {
    throw new Error(`${toolName} did not return successful text content`);
  }
  return text;
}

async function checkEndpoint() {
  const initialize = await requestJsonRpc({
    jsonrpc: '2.0',
    id: 'smoke-initialize',
    method: 'initialize',
    params: {
      protocolVersion,
      capabilities: {},
      clientInfo: { name: 'smithy-mcp-deployment-smoke', version: '1.0.0' }
    }
  });
  if (
    typeof initialize.result !== 'object' ||
    typeof initialize.result?.protocolVersion !== 'string'
  ) {
    throw new Error('response was not a valid initialize result');
  }

  if (!requireContent) {
    return;
  }

  const topicsText = toolText(
    await requestJsonRpc({
      jsonrpc: '2.0',
      id: 'smoke-list',
      method: 'tools/call',
      params: { name: 'list_smithy_topics', arguments: {} }
    }),
    'list_smithy_topics'
  );
  const firstPath = topicsText
    .split(/\r?\n/)
    .find(line => line.startsWith('- '))
    ?.slice(2)
    .trim();
  if (!firstPath) {
    throw new Error('list_smithy_topics returned no published documents');
  }

  toolText(
    await requestJsonRpc({
      jsonrpc: '2.0',
      id: 'smoke-read',
      method: 'tools/call',
      params: { name: 'read_smithy_doc', arguments: { file_path: firstPath } }
    }),
    'read_smithy_doc'
  );

  const searchText = toolText(
    await requestJsonRpc({
      jsonrpc: '2.0',
      id: 'smoke-search',
      method: 'tools/call',
      params: {
        name: 'search_smithy_docs',
        arguments: { query: 'Smithy service definitions', max_results: 1 }
      }
    }),
    'search_smithy_docs'
  );
  if (!searchText.startsWith('# Search Results:')) {
    throw new Error('search_smithy_docs returned no semantic results');
  }
}

for (let attempt = 1; attempt <= attempts; attempt += 1) {
  try {
    await checkEndpoint();
    console.log('MCP Streamable HTTP smoke test passed.');
    process.exit(0);
  } catch (error) {
    if (attempt === attempts) {
      const reason = error instanceof Error ? error.message : 'unknown failure';
      console.error(`MCP smoke test failed after ${attempts} attempts: ${reason}`);
      process.exit(1);
    }
    console.warn(`MCP smoke attempt ${attempt} failed; retrying.`);
    await new Promise(resolve => setTimeout(resolve, Math.min(1000 * 2 ** (attempt - 1), 8000)));
  }
}
