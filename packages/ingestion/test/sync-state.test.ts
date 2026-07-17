import { describe, expect, it, vi } from 'vitest';
import {
  acquirePendingSyncState,
  clearPendingSyncState,
  pendingSyncStateKey,
  type BedrockPendingSync,
  type BedrockSyncIdentity
} from '../src/sync-state.js';
import type { S3Sender } from '../src/upload-s3.js';

const prefix = 'smithy-docs/';
const identity: BedrockSyncIdentity = {
  publicationId: 'a'.repeat(64),
  upstreamSha: 'b'.repeat(40),
  sourceRepository: 'https://github.com/smithy-lang/smithy.git',
  knowledgeBaseId: 'KB12345678',
  dataSourceId: 'DS12345678'
};

const desiredPending: BedrockPendingSync = {
  version: 1,
  ...identity,
  ownerId: 'desired-owner',
  clientToken: 'c'.repeat(64)
};

function commandDetails(command: unknown): { name: string; input: Record<string, unknown> } {
  const value = command as { constructor: { name: string }; input: Record<string, unknown> };
  return { name: value.constructor.name, input: value.input };
}

function missing(): Error {
  return Object.assign(new Error('missing'), { name: 'NoSuchKey' });
}

function preconditionFailed(): Error {
  return Object.assign(new Error('changed'), {
    name: 'PreconditionFailed',
    $metadata: { httpStatusCode: 412 }
  });
}

describe('Bedrock pending synchronization fencing', () => {
  it('conditionally displaces a stale pending record for another publication', async () => {
    const key = pendingSyncStateKey(prefix);
    let object: { body: string; eTag: string } | undefined = {
      body: JSON.stringify({
        ...desiredPending,
        publicationId: 'd'.repeat(64),
        upstreamSha: 'e'.repeat(40),
        ownerId: 'stale-owner',
        clientToken: 'f'.repeat(64)
      }),
      eTag: '"stale-etag"'
    };
    const calls: Array<{ name: string; input: Record<string, unknown> }> = [];
    const s3: S3Sender = {
      send: vi.fn(async command => {
        const details = commandDetails(command);
        calls.push(details);
        if (details.name === 'GetObjectCommand') {
          if (object === undefined) throw missing();
          return { Body: object.body, ETag: object.eTag };
        }
        if (details.name === 'DeleteObjectCommand') {
          expect(details.input.IfMatch).toBe('"stale-etag"');
          object = undefined;
          return {};
        }
        if (details.name === 'PutObjectCommand') {
          expect(details.input.IfNoneMatch).toBe('*');
          object = { body: String(details.input.Body), eTag: '"desired-etag"' };
          return { ETag: object.eTag };
        }
        throw new Error(`Unexpected command ${details.name}`);
      })
    };

    await expect(
      acquirePendingSyncState(
        s3,
        'docs-bucket',
        prefix,
        identity,
        desiredPending.ownerId,
        desiredPending.clientToken
      )
    ).resolves.toEqual({ state: desiredPending, eTag: '"desired-etag"' });
    expect(calls.map(call => call.name)).toEqual([
      'GetObjectCommand',
      'DeleteObjectCommand',
      'PutObjectCommand'
    ]);
    expect(key.startsWith(prefix)).toBe(false);
  });

  it('fails closed on malformed untrusted pending JSON without mutating it', async () => {
    const send = vi.fn(async (command: unknown) => {
      const details = commandDetails(command);
      if (details.name === 'GetObjectCommand') {
        return { Body: '{"version":1,"clientToken":42}', ETag: '"malformed"' };
      }
      throw new Error(`Unexpected mutation ${details.name}`);
    });

    await expect(
      acquirePendingSyncState(
        { send },
        'docs-bucket',
        prefix,
        identity,
        desiredPending.ownerId,
        desiredPending.clientToken
      )
    ).rejects.toThrow('pending sync state is invalid');
    expect(send).toHaveBeenCalledTimes(1);
  });

  it('never deletes a replacement owner after conditional cleanup loses its race', async () => {
    const replacement: BedrockPendingSync = {
      ...desiredPending,
      publicationId: '9'.repeat(64),
      upstreamSha: '8'.repeat(40),
      ownerId: 'replacement-owner',
      clientToken: '7'.repeat(64)
    };
    let readCount = 0;
    let deleteCount = 0;
    const send = vi.fn(async (command: unknown) => {
      const details = commandDetails(command);
      if (details.name === 'GetObjectCommand') {
        readCount += 1;
        return readCount === 1
          ? { Body: JSON.stringify(desiredPending), ETag: '"old-etag"' }
          : { Body: JSON.stringify(replacement), ETag: '"replacement-etag"' };
      }
      if (details.name === 'DeleteObjectCommand') {
        deleteCount += 1;
        expect(details.input.IfMatch).toBe('"old-etag"');
        throw preconditionFailed();
      }
      throw new Error(`Unexpected command ${details.name}`);
    });

    await expect(
      clearPendingSyncState({ send }, 'docs-bucket', prefix, desiredPending)
    ).resolves.toBe(false);
    expect(deleteCount).toBe(1);
    expect(readCount).toBe(2);
  });
});
