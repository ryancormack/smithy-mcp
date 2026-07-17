import { DeleteObjectCommand, GetObjectCommand, PutObjectCommand } from '@aws-sdk/client-s3';
import { createHash } from 'node:crypto';
import { publicationStatePrefix } from './s3-keys.js';
import type { S3Sender } from './upload-s3.js';

const PENDING_SYNC_NAME = '_sync-pending.json';
const COMPLETED_SYNC_DIRECTORY = '_sync-completed';
const COMPLETED_JOB_DIRECTORY = '_sync-jobs';
const MAX_STATE_BYTES = 16 * 1024;

export interface BedrockSyncIdentity {
  publicationId: string;
  upstreamSha: string;
  sourceRepository: string;
  knowledgeBaseId: string;
  dataSourceId: string;
}

export interface BedrockPendingSync extends BedrockSyncIdentity {
  version: 1;
  ownerId: string;
  clientToken: string;
  ingestionJobId?: string;
}

export interface BedrockSyncState extends BedrockSyncIdentity {
  version: 1;
  clientToken: string;
  ingestionJobId: string;
}

export interface ObservedPendingSync {
  state: BedrockPendingSync;
  eTag: string;
}

function identityHash(identity: BedrockSyncIdentity): string {
  return createHash('sha256')
    .update(
      JSON.stringify({
        publicationId: identity.publicationId,
        upstreamSha: identity.upstreamSha,
        sourceRepository: identity.sourceRepository,
        knowledgeBaseId: identity.knowledgeBaseId,
        dataSourceId: identity.dataSourceId
      }),
      'utf8'
    )
    .digest('hex');
}

export function pendingSyncStateKey(prefix: string): string {
  return `${publicationStatePrefix(prefix)}${PENDING_SYNC_NAME}`;
}

export function completedSyncStateKey(prefix: string, identity: BedrockSyncIdentity): string {
  return `${publicationStatePrefix(prefix)}${COMPLETED_SYNC_DIRECTORY}/${identityHash(identity)}.json`;
}

export function completedSyncJobKey(prefix: string, state: BedrockSyncState): string {
  return `${publicationStatePrefix(prefix)}${COMPLETED_JOB_DIRECTORY}/${identityHash(state)}/${state.clientToken}.json`;
}

function isNotFound(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) {
    return false;
  }
  const candidate = error as { name?: string; $metadata?: { httpStatusCode?: number } };
  return (
    candidate.name === 'NoSuchKey' ||
    candidate.name === 'NotFound' ||
    candidate.$metadata?.httpStatusCode === 404
  );
}

function isPreconditionFailed(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) {
    return false;
  }
  const candidate = error as { name?: string; $metadata?: { httpStatusCode?: number } };
  return candidate.name === 'PreconditionFailed' || candidate.$metadata?.httpStatusCode === 412;
}

async function bodyToString(body: unknown): Promise<string> {
  let value: string;
  if (typeof body === 'string') {
    value = body;
  } else if (body instanceof Uint8Array) {
    value = Buffer.from(body).toString('utf8');
  } else if (
    typeof body === 'object' &&
    body !== null &&
    'transformToString' in body &&
    typeof (body as { transformToString?: unknown }).transformToString === 'function'
  ) {
    value = await (body as { transformToString: () => Promise<string> }).transformToString();
  } else {
    throw new Error('S3 sync-state response did not contain a readable body');
  }
  if (Buffer.byteLength(value, 'utf8') > MAX_STATE_BYTES) {
    throw new Error('Bedrock sync state is too large');
  }
  return value;
}

function isIdentity(value: Partial<BedrockSyncIdentity>): boolean {
  return (
    typeof value.publicationId === 'string' &&
    /^[0-9a-f]{64}$/.test(value.publicationId) &&
    typeof value.upstreamSha === 'string' &&
    /^[0-9a-f]{40,64}$/.test(value.upstreamSha) &&
    typeof value.sourceRepository === 'string' &&
    value.sourceRepository.length > 0 &&
    value.sourceRepository.length <= 2_048 &&
    typeof value.knowledgeBaseId === 'string' &&
    /^[A-Za-z0-9]{10}$/.test(value.knowledgeBaseId) &&
    typeof value.dataSourceId === 'string' &&
    /^[A-Za-z0-9]{10}$/.test(value.dataSourceId)
  );
}

function isClientToken(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length >= 33 &&
    value.length <= 256 &&
    /^[A-Za-z0-9][A-Za-z0-9-]*[A-Za-z0-9]$/.test(value)
  );
}

function isJobId(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Za-z0-9_-]{1,256}$/.test(value);
}

function validatePendingSync(value: unknown): BedrockPendingSync {
  if (typeof value !== 'object' || value === null) {
    throw new Error('Bedrock pending sync state is invalid');
  }
  const state = value as Partial<BedrockPendingSync>;
  if (
    state.version !== 1 ||
    !isIdentity(state) ||
    typeof state.ownerId !== 'string' ||
    !/^[A-Za-z0-9_-]{1,128}$/.test(state.ownerId) ||
    !isClientToken(state.clientToken) ||
    (state.ingestionJobId !== undefined && !isJobId(state.ingestionJobId))
  ) {
    throw new Error('Bedrock pending sync state is invalid');
  }
  return state as BedrockPendingSync;
}

function validateSyncState(value: unknown): BedrockSyncState {
  if (typeof value !== 'object' || value === null) {
    throw new Error('Bedrock completed sync state is invalid');
  }
  const state = value as Partial<BedrockSyncState>;
  if (
    state.version !== 1 ||
    !isIdentity(state) ||
    !isClientToken(state.clientToken) ||
    !isJobId(state.ingestionJobId)
  ) {
    throw new Error('Bedrock completed sync state is invalid');
  }
  return state as BedrockSyncState;
}

async function readJsonObject(
  s3: S3Sender,
  bucketName: string,
  key: string
): Promise<{ value: unknown; eTag: string } | undefined> {
  try {
    const response = (await s3.send(new GetObjectCommand({ Bucket: bucketName, Key: key }))) as {
      Body?: unknown;
      ETag?: string;
    };
    if (response.ETag === undefined || response.ETag === '') {
      throw new Error('S3 sync-state response did not contain an ETag');
    }
    const body = await bodyToString(response.Body);
    let value: unknown;
    try {
      value = JSON.parse(body) as unknown;
    } catch {
      throw new Error('Bedrock sync state is not valid JSON');
    }
    return { value, eTag: response.ETag };
  } catch (error) {
    if (isNotFound(error)) {
      return undefined;
    }
    throw error;
  }
}

function serializeState(state: BedrockPendingSync | BedrockSyncState): string {
  return `${JSON.stringify(state, null, 2)}\n`;
}

function checksum(body: string): string {
  return createHash('sha256').update(body, 'utf8').digest('base64');
}

export function syncIdentityMatches(
  state: BedrockSyncIdentity,
  identity: BedrockSyncIdentity
): boolean {
  return (
    state.publicationId === identity.publicationId &&
    state.upstreamSha === identity.upstreamSha &&
    state.sourceRepository === identity.sourceRepository &&
    state.knowledgeBaseId === identity.knowledgeBaseId &&
    state.dataSourceId === identity.dataSourceId
  );
}

export function syncStateMatches(
  state: BedrockSyncState | undefined,
  identity: BedrockSyncIdentity
): state is BedrockSyncState {
  return state !== undefined && syncIdentityMatches(state, identity);
}

export async function readPendingSyncState(
  s3: S3Sender,
  bucketName: string,
  prefix: string
): Promise<ObservedPendingSync | undefined> {
  const response = await readJsonObject(s3, bucketName, pendingSyncStateKey(prefix));
  return response === undefined
    ? undefined
    : { state: validatePendingSync(response.value), eTag: response.eTag };
}

export async function acquirePendingSyncState(
  s3: S3Sender,
  bucketName: string,
  prefix: string,
  identity: BedrockSyncIdentity,
  ownerId: string,
  clientToken: string
): Promise<ObservedPendingSync> {
  const candidate = validatePendingSync({
    version: 1,
    ...identity,
    ownerId,
    clientToken
  });
  const key = pendingSyncStateKey(prefix);

  for (let attempt = 0; attempt < 8; attempt += 1) {
    const observed = await readPendingSyncState(s3, bucketName, prefix);
    if (observed !== undefined) {
      if (syncIdentityMatches(observed.state, identity)) {
        return observed;
      }
      try {
        await s3.send(
          new DeleteObjectCommand({
            Bucket: bucketName,
            Key: key,
            IfMatch: observed.eTag
          })
        );
      } catch (error) {
        if (isPreconditionFailed(error) || isNotFound(error)) {
          continue;
        }
        throw error;
      }
    }

    const body = serializeState(candidate);
    try {
      const response = (await s3.send(
        new PutObjectCommand({
          Bucket: bucketName,
          Key: key,
          Body: body,
          ContentType: 'application/json; charset=utf-8',
          CacheControl: 'no-store',
          ChecksumSHA256: checksum(body),
          IfNoneMatch: '*',
          Metadata: {
            owner: ownerId,
            'publication-id': identity.publicationId,
            'upstream-sha': identity.upstreamSha
          }
        })
      )) as { ETag?: string };
      if (response.ETag === undefined || response.ETag === '') {
        throw new Error('S3 pending sync-state write did not contain an ETag');
      }
      return { state: candidate, eTag: response.ETag };
    } catch (error) {
      if (isPreconditionFailed(error)) {
        continue;
      }
      throw error;
    }
  }
  throw new Error('Unable to acquire Bedrock pending sync state');
}

export async function recordPendingIngestionJob(
  s3: S3Sender,
  bucketName: string,
  prefix: string,
  pending: ObservedPendingSync,
  ingestionJobId: string
): Promise<ObservedPendingSync> {
  const nextState = validatePendingSync({ ...pending.state, ingestionJobId });
  const key = pendingSyncStateKey(prefix);
  let observed = pending;

  for (let attempt = 0; attempt < 4; attempt += 1) {
    if (
      !syncIdentityMatches(observed.state, nextState) ||
      observed.state.clientToken !== nextState.clientToken
    ) {
      throw new Error('Bedrock pending sync ownership changed before the job ID was recorded');
    }
    if (observed.state.ingestionJobId !== undefined) {
      if (observed.state.ingestionJobId !== ingestionJobId) {
        throw new Error('Bedrock idempotency token returned conflicting ingestion job IDs');
      }
      return observed;
    }

    const body = serializeState(nextState);
    try {
      const response = (await s3.send(
        new PutObjectCommand({
          Bucket: bucketName,
          Key: key,
          Body: body,
          ContentType: 'application/json; charset=utf-8',
          CacheControl: 'no-store',
          ChecksumSHA256: checksum(body),
          IfMatch: observed.eTag,
          Metadata: {
            owner: nextState.ownerId,
            'publication-id': nextState.publicationId,
            'upstream-sha': nextState.upstreamSha,
            'ingestion-job-id': ingestionJobId
          }
        })
      )) as { ETag?: string };
      if (response.ETag === undefined || response.ETag === '') {
        throw new Error('S3 pending job update did not contain an ETag');
      }
      return { state: nextState, eTag: response.ETag };
    } catch (error) {
      if (!isPreconditionFailed(error)) {
        throw error;
      }
      const current = await readPendingSyncState(s3, bucketName, prefix);
      if (current === undefined) {
        throw new Error('Bedrock pending sync state disappeared before the job ID was recorded');
      }
      observed = current;
    }
  }
  throw new Error('Unable to record the Bedrock ingestion job ID');
}

async function readCompletedStateAtKey(
  s3: S3Sender,
  bucketName: string,
  key: string
): Promise<BedrockSyncState | undefined> {
  const response = await readJsonObject(s3, bucketName, key);
  return response === undefined ? undefined : validateSyncState(response.value);
}

export async function readBedrockSyncState(
  s3: S3Sender,
  bucketName: string,
  prefix: string,
  identity: BedrockSyncIdentity
): Promise<BedrockSyncState | undefined> {
  return readCompletedStateAtKey(s3, bucketName, completedSyncStateKey(prefix, identity));
}

export async function readCompletedPendingJob(
  s3: S3Sender,
  bucketName: string,
  prefix: string,
  pending: BedrockPendingSync
): Promise<BedrockSyncState | undefined> {
  if (pending.ingestionJobId === undefined) {
    return undefined;
  }
  const expected: BedrockSyncState = {
    version: 1,
    publicationId: pending.publicationId,
    upstreamSha: pending.upstreamSha,
    sourceRepository: pending.sourceRepository,
    knowledgeBaseId: pending.knowledgeBaseId,
    dataSourceId: pending.dataSourceId,
    clientToken: pending.clientToken,
    ingestionJobId: pending.ingestionJobId
  };
  const completed = await readCompletedStateAtKey(
    s3,
    bucketName,
    completedSyncJobKey(prefix, expected)
  );
  if (
    completed !== undefined &&
    (!syncIdentityMatches(completed, expected) ||
      completed.clientToken !== expected.clientToken ||
      completed.ingestionJobId !== expected.ingestionJobId)
  ) {
    throw new Error('Bedrock completed job state does not match its key');
  }
  return completed;
}

async function writeImmutableCompletedState(
  s3: S3Sender,
  bucketName: string,
  key: string,
  state: BedrockSyncState,
  allowPriorJobForIdentity: boolean
): Promise<void> {
  const body = serializeState(state);
  try {
    await s3.send(
      new PutObjectCommand({
        Bucket: bucketName,
        Key: key,
        Body: body,
        ContentType: 'application/json; charset=utf-8',
        CacheControl: 'no-cache',
        ChecksumSHA256: checksum(body),
        IfNoneMatch: '*',
        Metadata: {
          'publication-id': state.publicationId,
          'upstream-sha': state.upstreamSha,
          'ingestion-job-id': state.ingestionJobId
        }
      })
    );
  } catch (error) {
    if (!isPreconditionFailed(error)) {
      throw error;
    }
    const existing = await readCompletedStateAtKey(s3, bucketName, key);
    if (
      existing === undefined ||
      !syncIdentityMatches(existing, state) ||
      (!allowPriorJobForIdentity &&
        (existing.clientToken !== state.clientToken ||
          existing.ingestionJobId !== state.ingestionJobId))
    ) {
      throw new Error('Existing Bedrock completed sync state conflicts with this synchronization');
    }
  }
}

export async function writeBedrockSyncState(
  s3: S3Sender,
  bucketName: string,
  prefix: string,
  pending: ObservedPendingSync,
  ingestionJobId: string
): Promise<BedrockSyncState> {
  if (pending.state.ingestionJobId !== ingestionJobId) {
    throw new Error('Cannot complete a Bedrock sync before its job ID is durably pending');
  }
  const current = await readPendingSyncState(s3, bucketName, prefix);
  if (
    current === undefined ||
    !syncIdentityMatches(current.state, pending.state) ||
    current.state.ownerId !== pending.state.ownerId ||
    current.state.clientToken !== pending.state.clientToken ||
    current.state.ingestionJobId !== ingestionJobId
  ) {
    throw new Error('Bedrock pending sync ownership changed before completion');
  }

  const state: BedrockSyncState = {
    version: 1,
    publicationId: pending.state.publicationId,
    upstreamSha: pending.state.upstreamSha,
    sourceRepository: pending.state.sourceRepository,
    knowledgeBaseId: pending.state.knowledgeBaseId,
    dataSourceId: pending.state.dataSourceId,
    clientToken: pending.state.clientToken,
    ingestionJobId
  };
  await writeImmutableCompletedState(
    s3,
    bucketName,
    completedSyncJobKey(prefix, state),
    state,
    false
  );
  await writeImmutableCompletedState(
    s3,
    bucketName,
    completedSyncStateKey(prefix, state),
    state,
    true
  );
  return state;
}

export async function clearPendingSyncState(
  s3: S3Sender,
  bucketName: string,
  prefix: string,
  expected: BedrockPendingSync
): Promise<boolean> {
  const key = pendingSyncStateKey(prefix);
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const current = await readPendingSyncState(s3, bucketName, prefix);
    if (current === undefined) {
      return true;
    }
    if (
      !syncIdentityMatches(current.state, expected) ||
      current.state.ownerId !== expected.ownerId ||
      current.state.clientToken !== expected.clientToken ||
      current.state.ingestionJobId !== expected.ingestionJobId
    ) {
      return false;
    }
    try {
      await s3.send(
        new DeleteObjectCommand({
          Bucket: bucketName,
          Key: key,
          IfMatch: current.eTag
        })
      );
      return true;
    } catch (error) {
      if (isPreconditionFailed(error) || isNotFound(error)) {
        continue;
      }
      throw error;
    }
  }
  return false;
}
