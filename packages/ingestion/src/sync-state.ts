import { GetObjectCommand, PutObjectCommand } from '@aws-sdk/client-s3';
import { createHash } from 'node:crypto';
import { publicationStatePrefix } from './s3-keys.js';
import type { S3Sender } from './upload-s3.js';

const SYNC_STATE_NAME = '_sync-state.json';

export interface BedrockSyncState {
  version: 1;
  upstreamSha: string;
  knowledgeBaseId: string;
  dataSourceId: string;
  ingestionJobId: string;
}

function stateKey(prefix: string): string {
  return `${publicationStatePrefix(prefix)}${SYNC_STATE_NAME}`;
}

function isNotFound(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) {
    return false;
  }
  const candidate = error as { name?: string; $metadata?: { httpStatusCode?: number } };
  return candidate.name === 'NoSuchKey' || candidate.name === 'NotFound' ||
    candidate.$metadata?.httpStatusCode === 404;
}

async function bodyToString(body: unknown): Promise<string> {
  if (typeof body === 'string') {
    return body;
  }
  if (body instanceof Uint8Array) {
    return Buffer.from(body).toString('utf8');
  }
  if (
    typeof body === 'object' &&
    body !== null &&
    'transformToString' in body &&
    typeof (body as { transformToString?: unknown }).transformToString === 'function'
  ) {
    return (body as { transformToString: () => Promise<string> }).transformToString();
  }
  throw new Error('S3 sync-state response did not contain a readable body');
}

function validateSyncState(value: unknown): BedrockSyncState {
  if (typeof value !== 'object' || value === null) {
    throw new Error('Bedrock sync state is invalid');
  }
  const state = value as Partial<BedrockSyncState>;
  if (
    state.version !== 1 ||
    typeof state.upstreamSha !== 'string' ||
    !/^[0-9a-f]{40,64}$/.test(state.upstreamSha) ||
    typeof state.knowledgeBaseId !== 'string' ||
    typeof state.dataSourceId !== 'string' ||
    typeof state.ingestionJobId !== 'string' ||
    state.ingestionJobId === ''
  ) {
    throw new Error('Bedrock sync state is invalid');
  }
  return state as BedrockSyncState;
}

export async function readBedrockSyncState(
  s3: S3Sender,
  bucketName: string,
  prefix: string
): Promise<BedrockSyncState | undefined> {
  try {
    const response = (await s3.send(new GetObjectCommand({
      Bucket: bucketName,
      Key: stateKey(prefix)
    }))) as { Body?: unknown };
    return validateSyncState(JSON.parse(await bodyToString(response.Body)) as unknown);
  } catch (error) {
    if (isNotFound(error)) {
      return undefined;
    }
    throw error;
  }
}

export async function writeBedrockSyncState(
  s3: S3Sender,
  bucketName: string,
  prefix: string,
  state: BedrockSyncState
): Promise<void> {
  const body = `${JSON.stringify(state, null, 2)}\n`;
  await s3.send(new PutObjectCommand({
    Bucket: bucketName,
    Key: stateKey(prefix),
    Body: body,
    ContentType: 'application/json; charset=utf-8',
    CacheControl: 'no-cache',
    ChecksumSHA256: createHash('sha256').update(body, 'utf8').digest('base64'),
    Metadata: { 'upstream-sha': state.upstreamSha }
  }));
}

export function syncStateMatches(
  state: BedrockSyncState | undefined,
  upstreamSha: string,
  knowledgeBaseId: string,
  dataSourceId: string
): boolean {
  return state?.upstreamSha === upstreamSha &&
    state.knowledgeBaseId === knowledgeBaseId &&
    state.dataSourceId === dataSourceId;
}
