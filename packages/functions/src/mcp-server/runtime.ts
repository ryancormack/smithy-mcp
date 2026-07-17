import path from 'node:path';

export const DOCUMENT_PREFIX = 'smithy-docs/';
export const MAX_REQUEST_BODY_BYTES = 256 * 1024;
export const MAX_TOOL_OUTPUT_BYTES = 256 * 1024;
export const MAX_QUERY_LENGTH = 2_000;
export const MAX_FILE_PATH_LENGTH = 1_024;
export const MAX_LISTED_DOCUMENTS = 5_000;

const TRUNCATION_NOTICE = '\n\n[Output truncated to stay within the response limit.]';

export interface RuntimeConfig {
  bucketName: string;
  knowledgeBaseId: string;
  resourceRegion: string;
  allowedHosts: string[];
  allowedOrigins: string[];
  port: number;
}

export interface ObjectPage {
  keys: Array<string | undefined>;
  nextToken?: string;
}

export interface PaginatedKeys {
  keys: string[];
  truncated: boolean;
}

export interface RequestHeaders {
  host?: string;
  origin?: string;
}

export class ConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConfigurationError';
  }
}

export class InvalidDocumentPathError extends Error {
  constructor() {
    super('Invalid document path');
    this.name = 'InvalidDocumentPathError';
  }
}

function requireEnvironmentValue(environment: NodeJS.ProcessEnv, name: string): string {
  const value = environment[name]?.trim();
  if (!value) {
    throw new ConfigurationError(`${name} is required`);
  }
  return value;
}

function parseList(value: string, name: string): string[] {
  const entries = value
    .split(',')
    .map(entry => entry.trim())
    .filter(Boolean);
  if (entries.length === 0) {
    throw new ConfigurationError(`${name} must contain at least one value`);
  }
  if (entries.length > 20) {
    throw new ConfigurationError(`${name} cannot contain more than 20 values`);
  }
  if (entries.some(entry => entry.includes('*'))) {
    throw new ConfigurationError(`${name} cannot contain wildcards`);
  }
  return entries;
}

export function normalizeHost(value: string): string {
  const candidate = value.trim().toLowerCase();
  if (!candidate || candidate.includes('/') || candidate.includes('@')) {
    throw new ConfigurationError('Host entries must contain only a hostname and optional port');
  }

  let parsed: URL;
  try {
    parsed = new URL(`http://${candidate}`);
  } catch {
    throw new ConfigurationError('Host entries must contain only a hostname and optional port');
  }

  if (!parsed.hostname || parsed.pathname !== '/' || parsed.search || parsed.hash) {
    throw new ConfigurationError('Host entries must contain only a hostname and optional port');
  }
  return parsed.host;
}

export function normalizeOrigin(value: string): string {
  let parsed: URL;
  try {
    parsed = new URL(value.trim());
  } catch {
    throw new ConfigurationError('Origin entries must be valid HTTP or HTTPS origins');
  }

  if (
    (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') ||
    parsed.username ||
    parsed.password ||
    parsed.pathname !== '/' ||
    parsed.search ||
    parsed.hash
  ) {
    throw new ConfigurationError('Origin entries must be valid HTTP or HTTPS origins');
  }
  return parsed.origin;
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}

export function loadRuntimeConfig(environment: NodeJS.ProcessEnv = process.env): RuntimeConfig {
  const bucketName = requireEnvironmentValue(environment, 'BUCKET_NAME');
  const knowledgeBaseId = requireEnvironmentValue(environment, 'KNOWLEDGE_BASE_ID');
  const resourceRegion = requireEnvironmentValue(environment, 'AWS_RESOURCE_REGION');
  if (!/^[a-z]{2}(?:-gov)?-[a-z]+-\d$/.test(resourceRegion)) {
    throw new ConfigurationError('AWS_RESOURCE_REGION must be a valid AWS region');
  }
  const allowedHosts = unique(
    parseList(requireEnvironmentValue(environment, 'MCP_ALLOWED_HOSTS'), 'MCP_ALLOWED_HOSTS').map(
      normalizeHost
    )
  );
  const allowedOrigins = unique(
    parseList(
      requireEnvironmentValue(environment, 'MCP_ALLOWED_ORIGINS'),
      'MCP_ALLOWED_ORIGINS'
    ).map(normalizeOrigin)
  );
  const portValue = environment.PORT?.trim() || '8080';
  const port = Number(portValue);

  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new ConfigurationError('PORT must be an integer between 1 and 65535');
  }

  return {
    bucketName,
    knowledgeBaseId,
    resourceRegion,
    allowedHosts,
    allowedOrigins,
    port
  };
}

export function isRequestAllowed(
  headers: RequestHeaders,
  config: Pick<RuntimeConfig, 'allowedHosts' | 'allowedOrigins'>
): boolean {
  if (!headers.host) {
    return false;
  }

  let host: string;
  try {
    host = normalizeHost(headers.host);
  } catch {
    return false;
  }

  if (!config.allowedHosts.includes(host)) {
    return false;
  }

  if (!headers.origin) {
    return true;
  }

  let origin: string;
  try {
    origin = normalizeOrigin(headers.origin);
  } catch {
    return false;
  }
  return config.allowedOrigins.includes(origin);
}

export function canonicalizeDocumentKey(filePath: string): string {
  if (!filePath || filePath.length > MAX_FILE_PATH_LENGTH) {
    throw new InvalidDocumentPathError();
  }

  let decoded: string;
  try {
    decoded = decodeURIComponent(filePath.trim());
  } catch {
    throw new InvalidDocumentPathError();
  }

  if (!decoded || decoded.includes('\0')) {
    throw new InvalidDocumentPathError();
  }

  const portablePath = decoded.replaceAll('\\', '/').replace(/^\/+/, '');
  const segments = portablePath.split('/');
  if (segments.some(segment => segment === '..')) {
    throw new InvalidDocumentPathError();
  }

  const relativePath = segments.filter(segment => segment && segment !== '.').join('/');
  if (!relativePath) {
    throw new InvalidDocumentPathError();
  }

  const key = path.posix.join(DOCUMENT_PREFIX, relativePath);
  if (
    key === DOCUMENT_PREFIX.slice(0, -1) ||
    !key.startsWith(DOCUMENT_PREFIX) ||
    Buffer.byteLength(key, 'utf8') > 1_024
  ) {
    throw new InvalidDocumentPathError();
  }
  return key;
}

export function boundUtf8Text(text: string, maxBytes: number = MAX_TOOL_OUTPUT_BYTES): string {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < Buffer.byteLength(TRUNCATION_NOTICE)) {
    throw new RangeError('maxBytes is too small');
  }
  if (Buffer.byteLength(text, 'utf8') <= maxBytes) {
    return text;
  }

  const noticeBytes = Buffer.byteLength(TRUNCATION_NOTICE, 'utf8');
  let prefix = Buffer.from(text, 'utf8')
    .subarray(0, maxBytes - noticeBytes)
    .toString('utf8');
  while (Buffer.byteLength(prefix, 'utf8') + noticeBytes > maxBytes) {
    prefix = prefix.slice(0, -1);
  }
  return `${prefix}${TRUNCATION_NOTICE}`;
}

export function renderDocumentList(
  files: readonly string[],
  sourceTruncated: boolean,
  maxBytes: number = MAX_TOOL_OUTPUT_BYTES
): string {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 256) {
    throw new RangeError('maxBytes is too small');
  }

  const total = files.length;
  const header = (included: number) =>
    `# Smithy Documentation\n\nIncluded: ${included} of ${total} discovered files\n\n`;
  const sourceNotice = sourceTruncated
    ? `\n[Listing discovery stopped after ${MAX_LISTED_DOCUMENTS} keys; additional files may exist.]`
    : '';
  const outputNotice = TRUNCATION_NOTICE;
  const lines = files.map(file => `- ${file}\n`);
  const complete = `${header(total)}${lines.join('')}${sourceNotice}`;
  if (Buffer.byteLength(complete, 'utf8') <= maxBytes) {
    return complete;
  }

  // Reserve using the largest possible included-count width, then add only
  // complete paths. The final header can only be the same size or smaller.
  const fixedBytes = Buffer.byteLength(`${header(total)}${sourceNotice}${outputNotice}`, 'utf8');
  let included = 0;
  let lineBytes = 0;
  for (const line of lines) {
    const nextBytes = Buffer.byteLength(line, 'utf8');
    if (fixedBytes + lineBytes + nextBytes > maxBytes) {
      break;
    }
    lineBytes += nextBytes;
    included += 1;
  }

  let result = `${header(included)}${lines.slice(0, included).join('')}${sourceNotice}${outputNotice}`;
  while (included > 0 && Buffer.byteLength(result, 'utf8') > maxBytes) {
    included -= 1;
    result = `${header(included)}${lines.slice(0, included).join('')}${sourceNotice}${outputNotice}`;
  }
  return result;
}

export async function collectPaginatedKeys(
  loadPage: (continuationToken?: string) => Promise<ObjectPage>,
  maxKeys: number = MAX_LISTED_DOCUMENTS
): Promise<PaginatedKeys> {
  if (!Number.isSafeInteger(maxKeys) || maxKeys < 1) {
    throw new RangeError('maxKeys must be a positive integer');
  }

  const keys: string[] = [];
  const seenTokens = new Set<string>();
  let continuationToken: string | undefined;

  while (true) {
    const page = await loadPage(continuationToken);
    for (const key of page.keys) {
      if (!key) {
        continue;
      }
      if (keys.length === maxKeys) {
        return { keys, truncated: true };
      }
      keys.push(key);
    }

    if (!page.nextToken) {
      return { keys, truncated: false };
    }
    if (keys.length === maxKeys) {
      return { keys, truncated: true };
    }
    if (seenTokens.has(page.nextToken) || page.nextToken === continuationToken) {
      throw new Error('Pagination returned a repeated continuation token');
    }

    seenTokens.add(page.nextToken);
    continuationToken = page.nextToken;
  }
}

export function relativeDocumentPath(key: string): string | undefined {
  if (!key.startsWith(DOCUMENT_PREFIX) || key === DOCUMENT_PREFIX) {
    return undefined;
  }
  return key.slice(DOCUMENT_PREFIX.length);
}
