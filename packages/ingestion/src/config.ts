import { isReservedInternalPrefix } from './s3-keys.js';

const DEFAULT_SOURCE_REPOSITORY = 'https://github.com/smithy-lang/smithy.git';
const DEFAULT_SOURCE_REF = 'main';
const DEFAULT_DOCS_PREFIX = 'smithy-docs/';

export interface IngestionConfig {
  bucketName: string;
  knowledgeBaseId?: string;
  dataSourceId?: string;
  sourceRepository: string;
  sourceRef: string;
  docsPrefix: string;
  forceRefresh: boolean;
  commandTimeoutMs: number;
  commandMaxOutputBytes: number;
  conversionConcurrency: number;
  s3Concurrency: number;
  ingestionPollIntervalMs: number;
  ingestionPollMaxIntervalMs: number;
  ingestionTimeoutMs: number;
}

export interface LoadConfigOptions {
  requireBedrockIds?: boolean;
}

function required(environment: NodeJS.ProcessEnv, name: string): string {
  const value = environment[name]?.trim();
  if (value === undefined || value === '') {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

function positiveInteger(environment: NodeJS.ProcessEnv, name: string, fallback: number): number {
  const raw = environment[name]?.trim();
  if (raw === undefined || raw === '') {
    return fallback;
  }
  if (!/^\d+$/.test(raw)) {
    throw new Error(`${name} must be a positive integer`);
  }
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new Error(`${name} must be a positive integer`);
  }
  return value;
}

function optionalIdentifier(environment: NodeJS.ProcessEnv, name: string): string | undefined {
  const value = environment[name]?.trim();
  if (value === undefined || value === '') {
    return undefined;
  }
  if (!/^[A-Za-z0-9]{10}$/.test(value)) {
    throw new Error(`${name} must be exactly 10 alphanumeric characters`);
  }
  return value;
}

function validateBucketName(value: string): string {
  if (
    value.length < 3 ||
    value.length > 63 ||
    !/^[a-z0-9][a-z0-9.-]*[a-z0-9]$/.test(value) ||
    value.includes('..') ||
    /^\d+\.\d+\.\d+\.\d+$/.test(value)
  ) {
    throw new Error('BUCKET_NAME must be a valid S3 bucket name');
  }
  return value;
}

function booleanValue(environment: NodeJS.ProcessEnv, name: string, fallback: boolean): boolean {
  const raw = environment[name]?.trim().toLowerCase();
  if (raw === undefined || raw === '') {
    return fallback;
  }
  if (raw === 'true') {
    return true;
  }
  if (raw === 'false') {
    return false;
  }
  throw new Error(`${name} must be either true or false`);
}

export function validateSourceRepository(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error('SOURCE_REPOSITORY must be a valid HTTPS GitHub repository URL');
  }

  if (
    url.protocol !== 'https:' ||
    url.hostname.toLowerCase() !== 'github.com' ||
    url.username !== '' ||
    url.password !== '' ||
    url.port !== '' ||
    url.search !== '' ||
    url.hash !== '' ||
    !/^\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+(?:\.git)?$/.test(url.pathname)
  ) {
    throw new Error('SOURCE_REPOSITORY must be a credential-free HTTPS GitHub repository URL');
  }

  return url.toString().replace(/\/$/, '');
}

export function validateSourceRef(value: string): string {
  const ref = value.trim();
  if (
    ref.length < 1 ||
    ref.length > 200 ||
    ref.startsWith('-') ||
    ref.startsWith('/') ||
    ref.endsWith('/') ||
    ref.endsWith('.') ||
    ref.endsWith('.lock') ||
    ref.includes('..') ||
    ref.includes('//') ||
    ref.includes('@{') ||
    !/^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(ref)
  ) {
    throw new Error('SOURCE_REF is not a safe Git ref');
  }
  return ref;
}

function validatePrefix(value: string): string {
  const prefix = value.trim().replace(/^\/+/, '').replace(/\/+$/, '');
  const collidesWithInternalNamespace = isReservedInternalPrefix(prefix);
  if (
    prefix === '' ||
    prefix.includes('..') ||
    !/^[A-Za-z0-9._/-]+$/.test(prefix) ||
    collidesWithInternalNamespace
  ) {
    throw new Error('DOCS_PREFIX is not a safe S3 prefix');
  }
  return `${prefix}/`;
}

export function loadIngestionConfig(
  environment: NodeJS.ProcessEnv = process.env,
  options: LoadConfigOptions = {}
): IngestionConfig {
  const repositoryValue = environment.SOURCE_REPOSITORY?.trim();
  const repositoryUrlValue = environment.SOURCE_REPOSITORY_URL?.trim();
  if (
    repositoryValue !== undefined &&
    repositoryValue !== '' &&
    repositoryUrlValue !== undefined &&
    repositoryUrlValue !== '' &&
    repositoryValue !== repositoryUrlValue
  ) {
    throw new Error('SOURCE_REPOSITORY and SOURCE_REPOSITORY_URL must not conflict');
  }

  const knowledgeBaseId = optionalIdentifier(environment, 'KNOWLEDGE_BASE_ID');
  const dataSourceId = optionalIdentifier(environment, 'DATA_SOURCE_ID');
  if ((knowledgeBaseId === undefined) !== (dataSourceId === undefined)) {
    throw new Error('KNOWLEDGE_BASE_ID and DATA_SOURCE_ID must be supplied together');
  }
  if ((options.requireBedrockIds ?? true) && knowledgeBaseId === undefined) {
    throw new Error('Missing required environment variable: KNOWLEDGE_BASE_ID');
  }

  const pollInterval = positiveInteger(environment, 'INGESTION_POLL_INTERVAL_MS', 5_000);
  const pollMaximum = positiveInteger(environment, 'INGESTION_POLL_MAX_INTERVAL_MS', 30_000);
  if (pollMaximum < pollInterval) {
    throw new Error('INGESTION_POLL_MAX_INTERVAL_MS must be at least INGESTION_POLL_INTERVAL_MS');
  }

  return {
    bucketName: validateBucketName(required(environment, 'BUCKET_NAME')),
    knowledgeBaseId,
    dataSourceId,
    sourceRepository: validateSourceRepository(
      repositoryValue || repositoryUrlValue || DEFAULT_SOURCE_REPOSITORY
    ),
    sourceRef: validateSourceRef(environment.SOURCE_REF ?? DEFAULT_SOURCE_REF),
    docsPrefix: validatePrefix(environment.DOCS_PREFIX ?? DEFAULT_DOCS_PREFIX),
    forceRefresh: booleanValue(environment, 'FORCE_REFRESH', false),
    commandTimeoutMs: positiveInteger(environment, 'COMMAND_TIMEOUT_MS', 120_000),
    commandMaxOutputBytes: positiveInteger(environment, 'COMMAND_MAX_OUTPUT_BYTES', 16 * 1024 * 1024),
    conversionConcurrency: positiveInteger(environment, 'CONVERSION_CONCURRENCY', 4),
    s3Concurrency: positiveInteger(environment, 'S3_CONCURRENCY', 8),
    ingestionPollIntervalMs: pollInterval,
    ingestionPollMaxIntervalMs: pollMaximum,
    ingestionTimeoutMs: positiveInteger(environment, 'INGESTION_TIMEOUT_MS', 10 * 60_000)
  };
}
