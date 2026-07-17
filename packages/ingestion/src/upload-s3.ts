import {
  CopyObjectCommand,
  DeleteObjectCommand,
  DeleteObjectsCommand,
  GetObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client
} from '@aws-sdk/client-s3';
import { createHash, randomUUID } from 'node:crypto';
import { mapWithConcurrency } from './concurrency.js';
import type { MarkdownFile } from './convert-rst.js';
import {
  normalizeDocsPrefix,
  publicationStagingPrefix,
  publicationStatePrefix
} from './s3-keys.js';

const MANIFEST_NAME = 'manifest.json';
const STAGING_DIRECTORY = '_staging/';
const SYNC_STATE_NAME = '_sync-state.json';
const PUBLICATION_LOCK_NAME = '_publication-lock.json';
const PUBLICATION_LOCK_TTL_MS = 14 * 60_000;
const DELETE_BATCH_SIZE = 1_000;
const MAX_LIST_PAGES = 10_000;
const MAX_LISTED_OBJECTS = 1_000_000;
const CONTENT_TYPE = 'text/markdown; charset=utf-8';

export interface ManifestDocument {
  key: string;
  path: string;
  sha256: string;
  bytes: number;
  contentType: string;
}

export interface PublicationManifest {
  version: 1;
  sourceRepository: string;
  sourceRef: string;
  upstreamSha: string;
  documents: ManifestDocument[];
}

export interface PublicationState {
  body: string;
  eTag: string;
  manifest: PublicationManifest;
}

export class PublicationStateChangedError extends Error {
  readonly retryable = true;

  constructor() {
    super('Publication state changed before the publication lock was acquired');
    this.name = 'PublicationStateChangedError';
  }
}

export interface PublicationResult {
  manifest: PublicationManifest;
  changed: boolean;
}

export interface PublishOptions {
  bucketName: string;
  prefix: string;
  sourceRepository: string;
  sourceRef: string;
  upstreamSha: string;
  forceRefresh: boolean;
  concurrency: number;
}

export interface S3Sender {
  send(command: unknown): Promise<unknown>;
}

export interface PublishDependencies {
  s3?: S3Sender;
  createStageId?: () => string;
  existingState?: PublicationState | null;
  now?: () => number;
}

function normalizeDocumentPath(value: string): string {
  const path = value.replace(/\\/g, '/').replace(/^\/+/, '');
  if (
    path === '' ||
    path === '..' ||
    path.startsWith('../') ||
    path.includes('/../') ||
    path.includes('//') ||
    path === MANIFEST_NAME ||
    path === SYNC_STATE_NAME ||
    path === PUBLICATION_LOCK_NAME ||
    path.startsWith(STAGING_DIRECTORY)
  ) {
    throw new Error(`Unsafe or reserved document path: ${value}`);
  }
  return path;
}

function sha256(content: string): string {
  return createHash('sha256').update(content, 'utf8').digest('hex');
}

function checksumBase64(hexDigest: string): string {
  return Buffer.from(hexDigest, 'hex').toString('base64');
}

export function serializeManifest(manifest: PublicationManifest): string {
  return `${JSON.stringify(manifest, null, 2)}\n`;
}

function copySource(bucketName: string, key: string): string {
  return `${encodeURIComponent(bucketName)}/${key.split('/').map(encodeURIComponent).join('/')}`;
}

function chunks<T>(values: readonly T[], size: number): T[][] {
  const result: T[][] = [];
  for (let index = 0; index < values.length; index += size) {
    result.push(values.slice(index, index + size));
  }
  return result;
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
  throw new Error('S3 manifest response did not contain a readable body');
}

function validateManifest(value: unknown, docsPrefix: string): PublicationManifest {
  if (typeof value !== 'object' || value === null) {
    throw new Error('Existing publication manifest is invalid');
  }
  const candidate = value as Partial<PublicationManifest>;
  if (
    candidate.version !== 1 ||
    typeof candidate.sourceRepository !== 'string' ||
    typeof candidate.sourceRef !== 'string' ||
    typeof candidate.upstreamSha !== 'string' ||
    !/^[0-9a-f]{40,64}$/.test(candidate.upstreamSha) ||
    !Array.isArray(candidate.documents) ||
    candidate.documents.length > MAX_LISTED_OBJECTS ||
    candidate.documents.some(
      (document) =>
        typeof document !== 'object' ||
        document === null ||
        typeof document.key !== 'string' ||
        typeof document.path !== 'string' ||
        typeof document.sha256 !== 'string' ||
        !/^[0-9a-f]{64}$/.test(document.sha256) ||
        typeof document.bytes !== 'number' ||
        !Number.isSafeInteger(document.bytes) ||
        document.bytes < 0 ||
        document.contentType !== CONTENT_TYPE
    )
  ) {
    throw new Error('Existing publication manifest is invalid');
  }

  const prefix = normalizeDocsPrefix(docsPrefix);
  const seenPaths = new Set<string>();
  const seenKeys = new Set<string>();
  for (const document of candidate.documents) {
    let normalizedPath: string;
    try {
      normalizedPath = normalizeDocumentPath(document.path);
    } catch {
      throw new Error('Existing publication manifest is invalid');
    }
    if (
      normalizedPath !== document.path ||
      !document.path.endsWith('.md') ||
      document.key !== `${prefix}${document.path}` ||
      seenPaths.has(document.path) ||
      seenKeys.has(document.key)
    ) {
      throw new Error('Existing publication manifest is invalid');
    }
    seenPaths.add(document.path);
    seenKeys.add(document.key);
  }
  return candidate as PublicationManifest;
}

export async function readPublicationState(
  s3: S3Sender,
  bucketName: string,
  prefix: string
): Promise<PublicationState | undefined> {
  const key = `${publicationStatePrefix(prefix)}${MANIFEST_NAME}`;
  try {
    const response = (await s3.send(new GetObjectCommand({ Bucket: bucketName, Key: key }))) as {
      Body?: unknown;
      ETag?: string;
    };
    if (response.ETag === undefined || response.ETag === '') {
      throw new Error('S3 manifest response did not contain an ETag');
    }
    const body = await bodyToString(response.Body);
    return {
      body,
      eTag: response.ETag,
      manifest: validateManifest(JSON.parse(body) as unknown, prefix)
    };
  } catch (error) {
    if (isNotFound(error)) {
      return undefined;
    }
    throw error;
  }
}

function isPreconditionFailed(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) {
    return false;
  }
  const candidate = error as { name?: string; $metadata?: { httpStatusCode?: number } };
  return candidate.name === 'PreconditionFailed' || candidate.$metadata?.httpStatusCode === 412;
}

interface PublicationLock {
  key: string;
  eTag: string;
}

async function acquirePublicationLock(
  s3: S3Sender,
  bucketName: string,
  prefix: string,
  owner: string,
  now: () => number
): Promise<PublicationLock> {
  const key = `${publicationStatePrefix(prefix)}${PUBLICATION_LOCK_NAME}`;

  for (let attempt = 0; attempt < 2; attempt += 1) {
    const expiresAt = now() + PUBLICATION_LOCK_TTL_MS;
    try {
      const response = (await s3.send(new PutObjectCommand({
        Bucket: bucketName,
        Key: key,
        Body: `${JSON.stringify({ owner, expiresAt, phase: 'acquired' })}\n`,
        ContentType: 'application/json; charset=utf-8',
        CacheControl: 'no-store',
        IfNoneMatch: '*',
        Metadata: { owner }
      }))) as { ETag?: string };
      if (response.ETag === undefined || response.ETag === '') {
        throw new Error('S3 publication lock response did not contain an ETag');
      }
      return { key, eTag: response.ETag };
    } catch (error) {
      if (!isPreconditionFailed(error)) {
        throw error;
      }
    }

    const response = (await s3.send(new GetObjectCommand({
      Bucket: bucketName,
      Key: key
    }))) as { Body?: unknown; ETag?: string };
    const lockBody = JSON.parse(await bodyToString(response.Body)) as {
      owner?: unknown;
      expiresAt?: unknown;
      phase?: unknown;
    };
    if (
      typeof lockBody.owner !== 'string' ||
      typeof lockBody.expiresAt !== 'number' ||
      !Number.isSafeInteger(lockBody.expiresAt) ||
      (lockBody.phase !== 'acquired' && lockBody.phase !== 'publishing') ||
      response.ETag === undefined ||
      response.ETag === ''
    ) {
      throw new Error('Existing S3 publication lock is invalid');
    }
    if (lockBody.expiresAt > now()) {
      throw new Error(`Another publication is in progress (owner ${lockBody.owner})`);
    }
    if (lockBody.phase === 'publishing') {
      throw new Error(
        `Expired publishing lock requires manual recovery (owner ${lockBody.owner})`
      );
    }
    await s3.send(new DeleteObjectCommand({
      Bucket: bucketName,
      Key: key,
      IfMatch: response.ETag
    }));
  }

  throw new Error('Unable to acquire the S3 publication lock');
}

async function markPublicationLockPublishing(
  s3: S3Sender,
  bucketName: string,
  lock: PublicationLock,
  owner: string,
  now: () => number
): Promise<PublicationLock> {
  const response = (await s3.send(new PutObjectCommand({
    Bucket: bucketName,
    Key: lock.key,
    Body: `${JSON.stringify({
      owner,
      expiresAt: now() + PUBLICATION_LOCK_TTL_MS,
      phase: 'publishing'
    })}\n`,
    ContentType: 'application/json; charset=utf-8',
    CacheControl: 'no-store',
    IfMatch: lock.eTag,
    Metadata: { owner, phase: 'publishing' }
  }))) as { ETag?: string };
  if (response.ETag === undefined || response.ETag === '') {
    throw new Error('S3 publication lock transition did not contain an ETag');
  }
  return { key: lock.key, eTag: response.ETag };
}

async function releasePublicationLock(
  s3: S3Sender,
  bucketName: string,
  lock: PublicationLock
): Promise<void> {
  await s3.send(new DeleteObjectCommand({
    Bucket: bucketName,
    Key: lock.key,
    IfMatch: lock.eTag
  }));
}

async function withPublicationLock<T>(
  s3: S3Sender,
  bucketName: string,
  prefix: string,
  owner: string,
  now: () => number,
  preflight: () => Promise<void>,
  operation: () => Promise<T>
): Promise<T> {
  let lock = await acquirePublicationLock(s3, bucketName, prefix, owner, now);
  let operationError: unknown;
  try {
    await preflight();
    lock = await markPublicationLockPublishing(s3, bucketName, lock, owner, now);
    return await operation();
  } catch (error) {
    operationError = error;
    throw error;
  } finally {
    try {
      await releasePublicationLock(s3, bucketName, lock);
    } catch (releaseError) {
      if (operationError !== undefined) {
        throw new AggregateError(
          [operationError, releaseError],
          'Publication failed and its lock could not be released'
        );
      }
      throw releaseError;
    }
  }
}

async function listKeys(s3: S3Sender, bucketName: string, prefix: string): Promise<string[]> {
  const keys: string[] = [];
  let continuationToken: string | undefined;

  for (let page = 0; page < MAX_LIST_PAGES; page += 1) {
    const response = (await s3.send(
      new ListObjectsV2Command({
        Bucket: bucketName,
        Prefix: prefix,
        ContinuationToken: continuationToken,
        MaxKeys: 1_000
      })
    )) as {
      Contents?: Array<{ Key?: string }>;
      IsTruncated?: boolean;
      NextContinuationToken?: string;
    };
    for (const object of response.Contents ?? []) {
      if (object.Key !== undefined) {
        keys.push(object.Key);
        if (keys.length > MAX_LISTED_OBJECTS) {
          throw new Error(`S3 listing exceeded ${MAX_LISTED_OBJECTS} objects`);
        }
      }
    }
    if (!response.IsTruncated) {
      return keys;
    }
    if (
      response.NextContinuationToken === undefined ||
      response.NextContinuationToken === continuationToken
    ) {
      throw new Error('S3 listing returned an invalid continuation token');
    }
    continuationToken = response.NextContinuationToken;
  }

  throw new Error(`S3 listing exceeded ${MAX_LIST_PAGES} pages`);
}

function isLiveDocumentKey(key: string, prefix: string): boolean {
  if (!key.startsWith(prefix)) {
    return false;
  }
  const path = key.slice(prefix.length);
  try {
    return path.endsWith('.md') && normalizeDocumentPath(path) === path;
  } catch {
    return false;
  }
}

async function deleteKeys(
  s3: S3Sender,
  bucketName: string,
  keys: readonly string[],
  concurrency: number
): Promise<void> {
  const batches = chunks([...new Set(keys)].sort(), DELETE_BATCH_SIZE);
  await mapWithConcurrency(batches, concurrency, async (batch) => {
    const response = (await s3.send(
      new DeleteObjectsCommand({
        Bucket: bucketName,
        Delete: {
          Quiet: true,
          Objects: batch.map((Key) => ({ Key }))
        }
      })
    )) as { Errors?: Array<{ Key?: string; Code?: string; Message?: string }> };
    if ((response.Errors?.length ?? 0) > 0) {
      const details = response.Errors?.map(
        (error) => `${error.Key ?? 'unknown'}: ${error.Code ?? error.Message ?? 'delete failed'}`
      ).join(', ');
      throw new Error(`S3 failed to delete objects: ${details}`);
    }
  });
}

function createManifest(files: readonly MarkdownFile[], options: PublishOptions): PublicationManifest {
  const sortedFiles = [...files].sort((left, right) =>
    left.relativePath < right.relativePath ? -1 : left.relativePath > right.relativePath ? 1 : 0
  );
  const prefix = normalizeDocsPrefix(options.prefix);
  const seenPaths = new Set<string>();
  const documents = sortedFiles.map((file) => {
    const path = normalizeDocumentPath(file.relativePath);
    if (!path.endsWith('.md')) {
      throw new Error(`Document path must end in .md: ${path}`);
    }
    if (seenPaths.has(path)) {
      throw new Error(`Duplicate document path: ${path}`);
    }
    seenPaths.add(path);
    return {
      key: `${prefix}${path}`,
      path,
      sha256: sha256(file.content),
      bytes: Buffer.byteLength(file.content, 'utf8'),
      contentType: CONTENT_TYPE
    };
  });
  return {
    version: 1,
    sourceRepository: options.sourceRepository,
    sourceRef: options.sourceRef,
    upstreamSha: options.upstreamSha,
    documents
  };
}

export async function publishToS3(
  files: readonly MarkdownFile[],
  options: PublishOptions,
  dependencies: PublishDependencies = {}
): Promise<PublicationResult> {
  if (files.length === 0) {
    throw new Error('Cannot publish an empty document set');
  }
  const s3 = dependencies.s3 ?? new S3Client({ maxAttempts: 5 });
  const prefix = normalizeDocsPrefix(options.prefix);
  const manifestKey = `${publicationStatePrefix(prefix)}${MANIFEST_NAME}`;
  const manifest = createManifest(files, options);
  const nextManifestBody = serializeManifest(manifest);
  const existing = Object.prototype.hasOwnProperty.call(dependencies, 'existingState')
    ? dependencies.existingState ?? undefined
    : await readPublicationState(s3, options.bucketName, prefix);

  if (
    !options.forceRefresh &&
    existing?.manifest.sourceRepository === options.sourceRepository &&
    existing.manifest.upstreamSha === options.upstreamSha
  ) {
    return { manifest: existing.manifest, changed: false };
  }

  const stageId = (dependencies.createStageId ?? randomUUID)();
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(stageId)) {
    throw new Error('Stage ID contains unsafe characters');
  }
  const stagePrefix = publicationStagingPrefix(prefix, stageId);
  const stageKeys = manifest.documents.map((document) => `${stagePrefix}${document.path}`);
  let stageCleaned = false;

  const cleanupStage = async (): Promise<void> => {
    if (!stageCleaned) {
      await deleteKeys(s3, options.bucketName, stageKeys, options.concurrency);
      stageCleaned = true;
    }
  };

  try {
    const sortedFiles = [...files].sort((left, right) =>
      left.relativePath < right.relativePath ? -1 : left.relativePath > right.relativePath ? 1 : 0
    );
    await mapWithConcurrency(sortedFiles, options.concurrency, async (file, index) => {
      const document = manifest.documents[index];
      await s3.send(
        new PutObjectCommand({
          Bucket: options.bucketName,
          Key: stageKeys[index],
          Body: file.content,
          ContentType: CONTENT_TYPE,
          ChecksumSHA256: checksumBase64(document.sha256),
          Metadata: {
            format: 'markdown',
            sha256: document.sha256,
            'upstream-sha': options.upstreamSha,
            'source-file': file.sourceRelativePath
          }
        })
      );
    });

    await withPublicationLock(
      s3,
      options.bucketName,
      prefix,
      stageId,
      dependencies.now ?? Date.now,
      async () => {
        const lockedState = await readPublicationState(s3, options.bucketName, prefix);
        if (
          (existing === undefined && lockedState !== undefined) ||
          (existing !== undefined && lockedState?.eTag !== existing.eTag)
        ) {
          throw new PublicationStateChangedError();
        }
      },
      async () => {
        await mapWithConcurrency(manifest.documents, options.concurrency, async (document) => {
          await s3.send(
            new CopyObjectCommand({
              Bucket: options.bucketName,
              Key: document.key,
              CopySource: copySource(options.bucketName, `${stagePrefix}${document.path}`),
              ChecksumAlgorithm: 'SHA256',
              MetadataDirective: 'COPY'
            })
          );
        });

        const desiredKeys = new Set(manifest.documents.map((document) => document.key));
        const staleKeys = (await listKeys(s3, options.bucketName, prefix)).filter(
          (key) => isLiveDocumentKey(key, prefix) && !desiredKeys.has(key)
        );
        await deleteKeys(s3, options.bucketName, staleKeys, options.concurrency);
        await cleanupStage();

        await s3.send(
          new PutObjectCommand({
            Bucket: options.bucketName,
            Key: manifestKey,
            Body: nextManifestBody,
            ContentType: 'application/json; charset=utf-8',
            CacheControl: 'no-cache',
            ChecksumSHA256: checksumBase64(sha256(nextManifestBody)),
            Metadata: { 'upstream-sha': options.upstreamSha },
            IfMatch: existing?.eTag,
            IfNoneMatch: existing === undefined ? '*' : undefined
          })
        );
      }
    );

    return { manifest, changed: true };
  } catch (error) {
    try {
      await cleanupStage();
    } catch (cleanupError) {
      throw new AggregateError(
        [error, cleanupError],
        'Publication failed and staging cleanup also failed'
      );
    }
    throw error;
  }
}

export const uploadToS3 = publishToS3;
