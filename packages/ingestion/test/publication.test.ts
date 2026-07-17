import { describe, expect, it, vi } from 'vitest';
import type { MarkdownFile } from '../src/convert-rst.js';
import {
  publishToS3,
  readPublicationState,
  type PublicationManifest,
  type S3Sender
} from '../src/upload-s3.js';
import { publicationStagingPrefix, publicationStatePrefix } from '../src/s3-keys.js';

const DOCS_PREFIX = 'smithy-docs/';
const STATE_PREFIX = publicationStatePrefix(DOCS_PREFIX);
const MANIFEST_KEY = `${STATE_PREFIX}manifest.json`;
const LOCK_KEY = `${STATE_PREFIX}_publication-lock.json`;

function commandDetails(command: unknown): { name: string; input: Record<string, unknown> } {
  const value = command as { constructor: { name: string }; input: Record<string, unknown> };
  return { name: value.constructor.name, input: value.input };
}

function isManifestPut(details: { name: string; input: Record<string, unknown> }): boolean {
  return details.name === 'PutObjectCommand' && details.input.Key === MANIFEST_KEY;
}

function isLockPut(details: { name: string; input: Record<string, unknown> }): boolean {
  return details.name === 'PutObjectCommand' && details.input.Key === LOCK_KEY;
}

function defaultS3Response(details: { name: string; input: Record<string, unknown> }): Record<string, unknown> {
  return isLockPut(details) ? { ETag: '"lock-etag"' } : {};
}

const files: MarkdownFile[] = [
  {
    path: '/tmp/checkout/docs/a.rst',
    sourceRelativePath: 'a.rst',
    relativePath: 'a.md',
    content: '---\ntitle: "A"\n---\n\n# A\n'
  }
];

const options = {
  bucketName: 'docs-bucket',
  prefix: DOCS_PREFIX,
  sourceRepository: 'https://github.com/example/docs.git',
  sourceRef: 'main',
  upstreamSha: 'a'.repeat(40),
  forceRefresh: false,
  concurrency: 2
};

function validManifest(upstreamSha = 'b'.repeat(40)): PublicationManifest {
  return {
    version: 1,
    sourceRepository: options.sourceRepository,
    sourceRef: options.sourceRef,
    upstreamSha,
    documents: [{
      key: `${DOCS_PREFIX}a.md`,
      path: 'a.md',
      sha256: 'c'.repeat(64),
      bytes: 1,
      contentType: 'text/markdown; charset=utf-8'
    }]
  };
}

describe('staged S3 publication', () => {
  it('uploads with checksums, reconciles paginated stale keys, cleans staging, and writes manifest last', async () => {
    const calls: Array<{ name: string; input: Record<string, unknown> }> = [];
    let listPage = 0;
    const s3: S3Sender = {
      send: vi.fn(async (command: unknown) => {
        const details = commandDetails(command);
        calls.push(details);
        if (details.name === 'GetObjectCommand') {
          throw Object.assign(new Error('missing'), { name: 'NoSuchKey' });
        }
        if (details.name === 'ListObjectsV2Command') {
          listPage += 1;
          return listPage === 1
            ? {
                Contents: [
                  { Key: 'smithy-docs/a.md' },
                  { Key: 'smithy-docs/stale-1.md' },
                  { Key: MANIFEST_KEY },
                  { Key: LOCK_KEY },
                  { Key: 'smithy-docs/legacy-control.json' }
                ],
                IsTruncated: true,
                NextContinuationToken: 'page-2'
              }
            : { Contents: [{ Key: 'smithy-docs/stale-2.md' }], IsTruncated: false };
        }
        return defaultS3Response(details);
      })
    };

    const result = await publishToS3(files, options, {
      s3,
      createStageId: () => 'fixed-stage'
    });

    expect(result.changed).toBe(true);
    expect(result.manifest.upstreamSha).toBe(options.upstreamSha);
    expect(result.manifest.documents).toHaveLength(1);
    expect(MANIFEST_KEY.startsWith(DOCS_PREFIX)).toBe(false);
    expect(LOCK_KEY.startsWith(DOCS_PREFIX)).toBe(false);
    const lockTransition = calls.find(
      (call) => isLockPut(call) && call.input.IfMatch === '"lock-etag"'
    );
    expect(lockTransition?.input.Body).toContain('"phase":"publishing"');
    const stagePrefix = publicationStagingPrefix(DOCS_PREFIX, 'fixed-stage');
    const stagePut = calls.find(
      (call) => call.name === 'PutObjectCommand' && String(call.input.Key).startsWith(stagePrefix)
    );
    expect(stagePut?.input.Key).toBe(`${stagePrefix}a.md`);
    expect(String(stagePut?.input.Key).startsWith(DOCS_PREFIX)).toBe(false);
    expect(stagePut?.input.ChecksumSHA256).toBeTypeOf('string');
    expect(stagePut?.input.Metadata).toMatchObject({
      'source-file': 'a.rst',
      'upstream-sha': options.upstreamSha
    });
    expect(listPage).toBe(2);
    const deletes = calls.filter((call) => call.name === 'DeleteObjectsCommand');
    expect(JSON.stringify(deletes)).toContain('smithy-docs/stale-1.md');
    expect(JSON.stringify(deletes)).toContain('smithy-docs/stale-2.md');
    expect(JSON.stringify(deletes)).toContain(`${stagePrefix}a.md`);
    expect(JSON.stringify(deletes)).not.toContain(MANIFEST_KEY);
    expect(JSON.stringify(deletes)).not.toContain(LOCK_KEY);
    expect(JSON.stringify(deletes)).not.toContain('smithy-docs/legacy-control.json');
    const listCalls = calls.filter((call) => call.name === 'ListObjectsV2Command');
    expect(listCalls.every((call) => call.input.Prefix === DOCS_PREFIX)).toBe(true);

    const manifestCallIndex = calls.findIndex(isManifestPut);
    const lockReleaseIndex = calls.findIndex(
      (call) => call.name === 'DeleteObjectCommand' &&
        call.input.Key === LOCK_KEY
    );
    expect(manifestCallIndex).toBeGreaterThan(-1);
    expect(lockReleaseIndex).toBe(manifestCallIndex + 1);
    expect(calls[manifestCallIndex].input.IfNoneMatch).toBe('*');
  });

  it('is a read-only no-op when the exact upstream SHA is unchanged', async () => {
    let manifestBody: string | undefined;
    const initialS3: S3Sender = {
      send: async (command: unknown) => {
        const details = commandDetails(command);
        if (details.name === 'GetObjectCommand') {
          throw Object.assign(new Error('missing'), { name: 'NoSuchKey' });
        }
        if (details.name === 'ListObjectsV2Command') {
          return { Contents: [{ Key: 'smithy-docs/a.md' }] };
        }
        if (isManifestPut(details)) {
          manifestBody = String(details.input.Body);
        }
        return defaultS3Response(details);
      }
    };
    await publishToS3(files, options, { s3: initialS3, createStageId: () => 'first' });

    const calls: string[] = [];
    const repeatS3: S3Sender = {
      send: async (command: unknown) => {
        const details = commandDetails(command);
        calls.push(details.name);
        if (details.name === 'GetObjectCommand') {
          return { Body: manifestBody, ETag: '"existing-etag"' };
        }
        throw new Error(`Unexpected mutation: ${details.name}`);
      }
    };
    const result = await publishToS3(files, options, { s3: repeatS3 });

    expect(result.changed).toBe(false);
    expect(calls).toEqual(['GetObjectCommand']);
  });

  it('uses unique staging prefixes while producing deterministic manifests', async () => {
    const stageKeys: string[] = [];
    const manifestBodies: string[] = [];
    const stageIds = ['stage-one', 'stage-two'];
    const s3: S3Sender = {
      send: async (command: unknown) => {
        const details = commandDetails(command);
        if (details.name === 'GetObjectCommand') {
          throw Object.assign(new Error('missing'), { name: 'NoSuchKey' });
        }
        if (details.name === 'PutObjectCommand' && isManifestPut(details)) {
          manifestBodies.push(String(details.input.Body));
        } else if (
          details.name === 'PutObjectCommand' &&
          String(details.input.Key).startsWith('smithy-mcp-staging/')
        ) {
          stageKeys.push(String(details.input.Key));
        }
        if (details.name === 'ListObjectsV2Command') {
          return { Contents: [] };
        }
        return defaultS3Response(details);
      }
    };

    await publishToS3(files, options, { s3, createStageId: () => stageIds.shift() ?? 'fallback' });
    await publishToS3(files, options, { s3, createStageId: () => stageIds.shift() ?? 'fallback' });

    expect(stageKeys).toEqual([
      `${publicationStagingPrefix(DOCS_PREFIX, 'stage-one')}a.md`,
      `${publicationStagingPrefix(DOCS_PREFIX, 'stage-two')}a.md`
    ]);
    expect(manifestBodies[0]).toBe(manifestBodies[1]);
  });

  it('preserves the prior manifest and cleans staging when promotion fails', async () => {
    const failure = new Error('canonical copy failed');
    const calls: Array<{ name: string; input: Record<string, unknown> }> = [];
    const previousOptions = { ...options, upstreamSha: 'b'.repeat(40) };
    let existingBody = '';
    const bootstrap: S3Sender = {
      send: async (command) => {
        const details = commandDetails(command);
        if (details.name === 'GetObjectCommand') {
          throw Object.assign(new Error('missing'), { name: 'NoSuchKey' });
        }
        if (details.name === 'ListObjectsV2Command') {
          return { Contents: [] };
        }
        if (isManifestPut(details)) {
          existingBody = String(details.input.Body);
        }
        return defaultS3Response(details);
      }
    };
    await publishToS3(files, previousOptions, { s3: bootstrap, createStageId: () => 'bootstrap' });

    const s3: S3Sender = {
      send: async (command: unknown) => {
        const details = commandDetails(command);
        calls.push(details);
        if (details.name === 'GetObjectCommand') {
          return { Body: existingBody, ETag: '"current-etag"' };
        }
        if (details.name === 'CopyObjectCommand') {
          throw failure;
        }
        return defaultS3Response(details);
      }
    };

    await expect(
      publishToS3(files, { ...options, forceRefresh: true }, { s3, createStageId: () => 'copy-failure' })
    ).rejects.toBe(failure);

    expect(calls.some(isManifestPut)).toBe(false);
    expect(JSON.stringify(calls.filter((call) => call.name === 'DeleteObjectsCommand')))
      .toContain(`${publicationStagingPrefix(DOCS_PREFIX, 'copy-failure')}a.md`);
  });

  it('cleans successfully staged objects after a partial stage failure', async () => {
    const twoFiles = [
      ...files,
      { ...files[0], path: '/tmp/b.rst', sourceRelativePath: 'b.rst', relativePath: 'b.md' }
    ];
    const failure = new Error('stage upload failed');
    const calls: Array<{ name: string; input: Record<string, unknown> }> = [];
    const s3: S3Sender = {
      send: async (command: unknown) => {
        const details = commandDetails(command);
        calls.push(details);
        if (details.name === 'GetObjectCommand') {
          throw Object.assign(new Error('missing'), { name: 'NoSuchKey' });
        }
        if (
          details.name === 'PutObjectCommand' &&
          details.input.Key === `${publicationStagingPrefix(DOCS_PREFIX, 'failed-stage')}b.md`
        ) {
          throw failure;
        }
        return defaultS3Response(details);
      }
    };

    await expect(
      publishToS3(twoFiles, options, { s3, createStageId: () => 'failed-stage' })
    ).rejects.toBe(failure);
    const cleanup = JSON.stringify(calls.filter((call) => call.name === 'DeleteObjectsCommand'));
    expect(cleanup).toContain(`${publicationStagingPrefix(DOCS_PREFIX, 'failed-stage')}a.md`);
    expect(cleanup).toContain(`${publicationStagingPrefix(DOCS_PREFIX, 'failed-stage')}b.md`);
    expect(calls.some(isManifestPut)).toBe(false);
  });

  it('does not mutate live keys when another non-expired publisher holds the lock', async () => {
    const calls: Array<{ name: string; input: Record<string, unknown> }> = [];
    const s3: S3Sender = {
      send: async (command: unknown) => {
        const details = commandDetails(command);
        calls.push(details);
        if (details.name === 'GetObjectCommand' && details.input.Key === MANIFEST_KEY) {
          throw Object.assign(new Error('missing'), { name: 'NoSuchKey' });
        }
        if (isLockPut(details)) {
          throw Object.assign(new Error('locked'), {
            name: 'PreconditionFailed',
            $metadata: { httpStatusCode: 412 }
          });
        }
        if (details.name === 'GetObjectCommand' && details.input.Key === LOCK_KEY) {
          return {
            Body: JSON.stringify({ owner: 'other-run', expiresAt: 2_000, phase: 'acquired' }),
            ETag: '"other-lock"'
          };
        }
        return defaultS3Response(details);
      }
    };

    await expect(publishToS3(files, options, {
      s3,
      createStageId: () => 'contending-run',
      now: () => 1_000
    })).rejects.toThrow('Another publication is in progress');

    expect(calls.some((call) => call.name === 'CopyObjectCommand')).toBe(false);
    expect(calls.some(isManifestPut)).toBe(false);
    expect(JSON.stringify(calls.filter((call) => call.name === 'DeleteObjectsCommand')))
      .toContain(`${publicationStagingPrefix(DOCS_PREFIX, 'contending-run')}a.md`);
  });

  it('aborts before live mutation when publication state changes before lock acquisition', async () => {
    const calls: Array<{ name: string; input: Record<string, unknown> }> = [];
    let manifestReadCount = 0;
    const s3: S3Sender = {
      send: async (command: unknown) => {
        const details = commandDetails(command);
        calls.push(details);
        if (details.name === 'GetObjectCommand' && details.input.Key === MANIFEST_KEY) {
          manifestReadCount += 1;
          return manifestReadCount === 1
            ? { Body: JSON.stringify(validManifest()), ETag: '"old-etag"' }
            : { Body: JSON.stringify(validManifest('d'.repeat(40))), ETag: '"new-etag"' };
        }
        return defaultS3Response(details);
      }
    };

    await expect(publishToS3(files, { ...options, forceRefresh: true }, {
      s3,
      createStageId: () => 'stale-reader'
    })).rejects.toMatchObject({
      name: 'PublicationStateChangedError',
      retryable: true
    });

    expect(manifestReadCount).toBe(2);
    expect(calls.some((call) => call.name === 'CopyObjectCommand')).toBe(false);
    expect(calls.some((call) => call.name === 'ListObjectsV2Command')).toBe(false);
    const deletedKeys = JSON.stringify(calls.filter((call) => call.name === 'DeleteObjectsCommand'));
    expect(deletedKeys).toContain(`${publicationStagingPrefix(DOCS_PREFIX, 'stale-reader')}a.md`);
    expect(deletedKeys).not.toContain(`${DOCS_PREFIX}a.md`);
  });

  it('takes over an expired external lock with an ETag-conditional delete', async () => {
    const calls: Array<{ name: string; input: Record<string, unknown> }> = [];
    let lockPutCount = 0;
    const s3: S3Sender = {
      send: async (command: unknown) => {
        const details = commandDetails(command);
        calls.push(details);
        if (details.name === 'GetObjectCommand' && details.input.Key === MANIFEST_KEY) {
          throw Object.assign(new Error('missing'), { name: 'NoSuchKey' });
        }
        if (isLockPut(details)) {
          lockPutCount += 1;
          if (lockPutCount === 1) {
            throw Object.assign(new Error('locked'), {
              name: 'PreconditionFailed',
              $metadata: { httpStatusCode: 412 }
            });
          }
          return { ETag: '"replacement-lock"' };
        }
        if (details.name === 'GetObjectCommand' && details.input.Key === LOCK_KEY) {
          return {
            Body: JSON.stringify({
              owner: 'expired-run',
              expiresAt: 999,
              phase: 'acquired'
            }),
            ETag: '"expired-lock"'
          };
        }
        if (details.name === 'ListObjectsV2Command') {
          return { Contents: [] };
        }
        return {};
      }
    };

    await expect(publishToS3(files, options, {
      s3,
      createStageId: () => 'takeover-run',
      now: () => 1_000
    })).resolves.toMatchObject({ changed: true });

    expect(LOCK_KEY.startsWith(DOCS_PREFIX)).toBe(false);
    const lockDeletes = calls.filter(
      (call) => call.name === 'DeleteObjectCommand' && call.input.Key === LOCK_KEY
    );
    expect(lockDeletes).toEqual([
      expect.objectContaining({ input: expect.objectContaining({ IfMatch: '"expired-lock"' }) }),
      expect.objectContaining({ input: expect.objectContaining({ IfMatch: '"replacement-lock"' }) })
    ]);
  });

  it('fails closed instead of taking over an expired lock that entered live publication', async () => {
    const calls: Array<{ name: string; input: Record<string, unknown> }> = [];
    const s3: S3Sender = {
      send: async (command: unknown) => {
        const details = commandDetails(command);
        calls.push(details);
        if (details.name === 'GetObjectCommand' && details.input.Key === MANIFEST_KEY) {
          throw Object.assign(new Error('missing'), { name: 'NoSuchKey' });
        }
        if (isLockPut(details)) {
          throw Object.assign(new Error('locked'), {
            name: 'PreconditionFailed',
            $metadata: { httpStatusCode: 412 }
          });
        }
        if (details.name === 'GetObjectCommand' && details.input.Key === LOCK_KEY) {
          return {
            Body: JSON.stringify({
              owner: 'stalled-publisher',
              expiresAt: 999,
              phase: 'publishing'
            }),
            ETag: '"publishing-lock"'
          };
        }
        return {};
      }
    };

    await expect(publishToS3(files, options, {
      s3,
      createStageId: () => 'blocked-takeover',
      now: () => 1_000
    })).rejects.toThrow('Expired publishing lock requires manual recovery');

    expect(calls.some((call) => call.name === 'CopyObjectCommand')).toBe(false);
    expect(calls.some((call) => call.name === 'ListObjectsV2Command')).toBe(false);
    expect(calls.some((call) => call.name === 'DeleteObjectCommand')).toBe(false);
  });

  it('rejects a live docs prefix that overlaps an internal namespace', async () => {
    const send = vi.fn(async () => ({}));

    await expect(publishToS3(files, {
      ...options,
      prefix: 'smithy-mcp-staging/nested/'
    }, { s3: { send } })).rejects.toThrow('collides with an internal S3 namespace');
    expect(send).not.toHaveBeenCalled();
  });

  it('rejects a manifest document key outside its normalized docs prefix', async () => {
    const manifest = validManifest();
    manifest.documents[0].key = 'other-prefix/a.md';
    const s3: S3Sender = {
      send: async () => ({ Body: JSON.stringify(manifest), ETag: '"etag"' })
    };

    await expect(readPublicationState(s3, options.bucketName, DOCS_PREFIX))
      .rejects.toThrow('Existing publication manifest is invalid');
  });

  it('rejects duplicate manifest paths and keys', async () => {
    const manifest = validManifest();
    manifest.documents.push({ ...manifest.documents[0] });
    const s3: S3Sender = {
      send: async () => ({ Body: JSON.stringify(manifest), ETag: '"etag"' })
    };

    await expect(readPublicationState(s3, options.bucketName, DOCS_PREFIX))
      .rejects.toThrow('Existing publication manifest is invalid');
  });
});
