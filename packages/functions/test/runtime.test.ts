import { Buffer } from 'node:buffer';
import { describe, expect, it, vi } from 'vitest';
import {
  boundUtf8Text,
  canonicalizeDocumentKey,
  collectPaginatedKeys,
  ConfigurationError,
  InvalidDocumentPathError,
  isRequestAllowed,
  loadRuntimeConfig,
  MAX_TOOL_OUTPUT_BYTES,
  normalizeHost,
  normalizeOrigin,
  relativeDocumentPath
} from '../src/mcp-server/runtime';

describe('loadRuntimeConfig', () => {
  const validEnvironment = {
    BUCKET_NAME: 'docs-bucket',
    KNOWLEDGE_BASE_ID: 'KB123',
    AWS_RESOURCE_REGION: 'us-west-2',
    MCP_ALLOWED_HOSTS: 'mcp.example.com, localhost:8080',
    MCP_ALLOWED_ORIGINS: 'https://app.example.com,http://localhost:3000',
    PORT: '8080'
  };

  it.each([
    'BUCKET_NAME',
    'KNOWLEDGE_BASE_ID',
    'AWS_RESOURCE_REGION',
    'MCP_ALLOWED_HOSTS',
    'MCP_ALLOWED_ORIGINS'
  ])('rejects a missing %s', name => {
    const environment = { ...validEnvironment };
    delete environment[name as keyof typeof environment];
    expect(() => loadRuntimeConfig(environment)).toThrow(ConfigurationError);
  });

  it('normalizes and deduplicates restrictive allowlists', () => {
    const config = loadRuntimeConfig({
      ...validEnvironment,
      MCP_ALLOWED_HOSTS: 'MCP.EXAMPLE.COM,mcp.example.com',
      MCP_ALLOWED_ORIGINS: 'https://APP.example.com,https://app.example.com/'
    });

    expect(config.allowedHosts).toEqual(['mcp.example.com']);
    expect(config.allowedOrigins).toEqual(['https://app.example.com']);
  });

  it('rejects wildcard policies and invalid ports', () => {
    expect(() => loadRuntimeConfig({
      ...validEnvironment,
      MCP_ALLOWED_HOSTS: '*'
    })).toThrow('cannot contain wildcards');
    expect(() => loadRuntimeConfig({
      ...validEnvironment,
      AWS_RESOURCE_REGION: 'not-a-region'
    })).toThrow('AWS_RESOURCE_REGION must be a valid AWS region');
    expect(() => loadRuntimeConfig({
      ...validEnvironment,
      PORT: '70000'
    })).toThrow('PORT must be an integer');
  });
});

describe('host and origin policy', () => {
  const policy = {
    allowedHosts: ['mcp.example.com', 'localhost:8080'],
    allowedOrigins: ['https://app.example.com']
  };

  it('normalizes configured hosts and origins', () => {
    expect(normalizeHost('MCP.EXAMPLE.COM')).toBe('mcp.example.com');
    expect(normalizeOrigin('https://APP.example.com/')).toBe('https://app.example.com');
  });

  it('allows configured hosts with an absent or configured origin', () => {
    expect(isRequestAllowed({ host: 'MCP.EXAMPLE.COM' }, policy)).toBe(true);
    expect(isRequestAllowed({
      host: 'mcp.example.com',
      origin: 'https://app.example.com/'
    }, policy)).toBe(true);
  });

  it('rejects missing or unconfigured hosts and origins', () => {
    expect(isRequestAllowed({}, policy)).toBe(false);
    expect(isRequestAllowed({ host: 'attacker.example' }, policy)).toBe(false);
    expect(isRequestAllowed({
      host: 'mcp.example.com',
      origin: 'https://attacker.example'
    }, policy)).toBe(false);
  });
});

describe('canonicalizeDocumentKey', () => {
  it.each([
    ['guides/intro.md', 'smithy-docs/guides/intro.md'],
    ['/guides//./intro.md', 'smithy-docs/guides/intro.md'],
    ['guides%2Fintro.md', 'smithy-docs/guides/intro.md']
  ])('canonicalizes %s under the documentation prefix', (input, expected) => {
    const key = canonicalizeDocumentKey(input);
    expect(key).toBe(expected);
    expect(key.startsWith('smithy-docs/')).toBe(true);
  });

  it.each([
    '../secret.md',
    'guides/../../secret.md',
    'guides\\..\\secret.md',
    '%2e%2e%2fsecret.md',
    '.',
    '%',
    '\0secret.md'
  ])('rejects traversal or invalid path %s', input => {
    expect(() => canonicalizeDocumentKey(input)).toThrow(InvalidDocumentPathError);
  });

  it('rejects keys that exceed the S3 key byte limit after prefixing', () => {
    expect(() => canonicalizeDocumentKey('a'.repeat(1_020))).toThrow(
      InvalidDocumentPathError
    );
  });

  it('only removes the exact documentation prefix', () => {
    expect(relativeDocumentPath('smithy-docs/guides/a.md')).toBe('guides/a.md');
    expect(relativeDocumentPath('smithy-docs-other/a.md')).toBeUndefined();
    expect(relativeDocumentPath('smithy-docs/')).toBeUndefined();
  });
});

describe('collectPaginatedKeys', () => {
  it('follows continuation tokens across all pages', async () => {
    const loadPage = vi.fn(async (token?: string) => {
      if (!token) {
        return { keys: ['smithy-docs/a.md'], nextToken: 'page-2' };
      }
      return { keys: [undefined, 'smithy-docs/b.md'] };
    });

    await expect(collectPaginatedKeys(loadPage)).resolves.toEqual({
      keys: ['smithy-docs/a.md', 'smithy-docs/b.md'],
      truncated: false
    });
    expect(loadPage).toHaveBeenNthCalledWith(1, undefined);
    expect(loadPage).toHaveBeenNthCalledWith(2, 'page-2');
  });

  it('stops at the result cap without loading another page', async () => {
    const loadPage = vi.fn(async () => ({
      keys: ['one', 'two', 'three'],
      nextToken: 'unused'
    }));

    await expect(collectPaginatedKeys(loadPage, 2)).resolves.toEqual({
      keys: ['one', 'two'],
      truncated: true
    });
    expect(loadPage).toHaveBeenCalledTimes(1);
  });

  it('rejects repeated continuation tokens', async () => {
    await expect(collectPaginatedKeys(async () => ({
      keys: [],
      nextToken: 'same-token'
    }))).rejects.toThrow('repeated continuation token');
  });
});

describe('boundUtf8Text', () => {
  it('keeps tool output within its UTF-8 byte cap', () => {
    const bounded = boundUtf8Text('😀'.repeat(MAX_TOOL_OUTPUT_BYTES), 256);
    expect(Buffer.byteLength(bounded, 'utf8')).toBeLessThanOrEqual(256);
    expect(bounded).toContain('[Output truncated');
  });

  it('does not alter output already within the cap', () => {
    expect(boundUtf8Text('short response', 256)).toBe('short response');
  });
});
