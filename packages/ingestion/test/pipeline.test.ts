import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import type { IngestionConfig } from '../src/config.js';
import { runIngestion } from '../src/pipeline.js';
import { publicationStatePrefix } from '../src/s3-keys.js';
import {
  completedSyncStateKey,
  pendingSyncStateKey,
  type BedrockSyncIdentity,
  type BedrockSyncState
} from '../src/sync-state.js';
import { serializeManifest, type S3Sender } from '../src/upload-s3.js';

const commitSha = 'a'.repeat(40);
const config: IngestionConfig = {
  bucketName: 'docs-bucket',
  knowledgeBaseId: 'KB12345678',
  dataSourceId: 'DS12345678',
  sourceRepository: 'https://github.com/smithy-lang/smithy.git',
  sourceRef: 'main',
  docsPrefix: 'smithy-docs/',
  forceRefresh: false,
  commandTimeoutMs: 1_000,
  commandMaxOutputBytes: 4_096,
  conversionConcurrency: 2,
  s3Concurrency: 2,
  ingestionPollIntervalMs: 10,
  ingestionPollMaxIntervalMs: 40,
  ingestionTimeoutMs: 100
};

const statePrefix = publicationStatePrefix(config.docsPrefix);
const manifestKey = `${statePrefix}manifest.json`;

const manifest = {
  version: 1 as const,
  sourceRepository: config.sourceRepository,
  sourceRef: config.sourceRef,
  upstreamSha: commitSha,
  documents: [
    {
      key: 'smithy-docs/a.md',
      path: 'a.md',
      sha256: 'b'.repeat(64),
      bytes: 10,
      contentType: 'text/markdown; charset=utf-8'
    }
  ]
};

const identity: BedrockSyncIdentity = {
  publicationId: createHash('sha256').update(serializeManifest(manifest), 'utf8').digest('hex'),
  upstreamSha: commitSha,
  sourceRepository: config.sourceRepository,
  knowledgeBaseId: 'KB12345678',
  dataSourceId: 'DS12345678'
};

function preconditionFailed(): Error {
  return Object.assign(new Error('precondition failed'), {
    name: 'PreconditionFailed',
    $metadata: { httpStatusCode: 412 }
  });
}

class MemoryS3 implements S3Sender {
  readonly objects = new Map<string, { body: string; eTag: string }>();
  readonly calls: Array<{ name: string; input: Record<string, unknown> }> = [];
  failPut?: (key: string, input: Record<string, unknown>) => Error | undefined;
  private revision = 0;

  constructor() {
    this.putDirect(manifestKey, serializeManifest(manifest));
  }

  putDirect(key: string, body: string): void {
    this.revision += 1;
    this.objects.set(key, { body, eTag: `"etag-${this.revision}"` });
  }

  async send(command: unknown): Promise<unknown> {
    const value = command as { constructor: { name: string }; input: Record<string, unknown> };
    const name = value.constructor.name;
    const input = value.input;
    const key = String(input.Key ?? '');
    this.calls.push({ name, input });

    if (name === 'GetObjectCommand') {
      const object = this.objects.get(key);
      if (object === undefined) {
        throw Object.assign(new Error('missing'), { name: 'NoSuchKey' });
      }
      return { Body: object.body, ETag: object.eTag };
    }
    if (name === 'PutObjectCommand') {
      const failure = this.failPut?.(key, input);
      if (failure !== undefined) {
        throw failure;
      }
      const existing = this.objects.get(key);
      if (input.IfNoneMatch === '*' && existing !== undefined) {
        throw preconditionFailed();
      }
      if (typeof input.IfMatch === 'string' && existing?.eTag !== input.IfMatch) {
        throw preconditionFailed();
      }
      this.putDirect(key, String(input.Body));
      return { ETag: this.objects.get(key)?.eTag };
    }
    if (name === 'DeleteObjectCommand') {
      const existing = this.objects.get(key);
      if (typeof input.IfMatch === 'string' && existing?.eTag !== input.IfMatch) {
        throw preconditionFailed();
      }
      this.objects.delete(key);
      return {};
    }
    throw new Error(`Unexpected S3 command: ${name}`);
  }
}

function cloneDependencies() {
  return {
    makeTemporaryDirectory: vi.fn(async () => '/tmp/smithy-docs-test'),
    removeDirectory: vi.fn(async () => undefined),
    execute: vi.fn(async (_command: string, args: readonly string[]) => ({
      stdout: args.includes('rev-parse') ? `${commitSha}\n` : '',
      stderr: ''
    }))
  };
}

function fixedIds() {
  return {
    createSyncOwnerId: () => 'owner-1',
    createClientToken: () => 'c'.repeat(64)
  };
}

function completedState(jobId = 'JOB123'): BedrockSyncState {
  return {
    version: 1,
    ...identity,
    clientToken: 'd'.repeat(64),
    ingestionJobId: jobId
  };
}

describe('ingestion pipeline synchronization recovery', () => {
  it('skips conversion and Bedrock when the unchanged publication has a completion witness', async () => {
    const s3 = new MemoryS3();
    s3.putDirect(
      completedSyncStateKey(config.docsPrefix, identity),
      JSON.stringify(completedState())
    );
    const bedrockSend = vi.fn(async () => {
      throw new Error('Bedrock must not be called');
    });
    const convertExecute = vi.fn(async () => {
      throw new Error('Pandoc must not be called');
    });

    const result = await runIngestion(config, {
      clone: cloneDependencies(),
      convert: { execute: convertExecute },
      s3,
      bedrock: { send: bedrockSend },
      logger: { info: vi.fn() },
      ...fixedIds()
    });

    expect(result).toEqual({ manifest, changed: false, ingestionJobId: 'JOB123' });
    expect(convertExecute).not.toHaveBeenCalled();
    expect(bedrockSend).not.toHaveBeenCalled();
  });

  it('reuses the persisted client token after a start response is accepted but job-ID persistence fails', async () => {
    const s3 = new MemoryS3();
    let failJobIdWrite = true;
    s3.failPut = (key, input) => {
      if (key === pendingSyncStateKey(config.docsPrefix) && input.IfMatch && failJobIdWrite) {
        failJobIdWrite = false;
        return new Error('simulated response-loss crash');
      }
      return undefined;
    };
    const startTokens: string[] = [];
    const bedrockSend = vi.fn(async (command: unknown) => {
      const value = command as { constructor: { name: string }; input: Record<string, unknown> };
      if (value.constructor.name === 'StartIngestionJobCommand') {
        startTokens.push(String(value.input.clientToken));
        return { ingestionJob: { ingestionJobId: 'JOB-ACCEPTED' } };
      }
      return { ingestionJob: { status: 'COMPLETE' } };
    });
    const dependencies = {
      clone: cloneDependencies(),
      s3,
      bedrock: { send: bedrockSend },
      logger: { info: vi.fn() },
      ...fixedIds()
    };

    await expect(runIngestion(config, dependencies)).rejects.toThrow('response-loss crash');
    const pendingAfterCrash = JSON.parse(
      s3.objects.get(pendingSyncStateKey(config.docsPrefix))?.body ?? '{}'
    ) as { clientToken?: string; ingestionJobId?: string };
    expect(pendingAfterCrash).toMatchObject({ clientToken: 'c'.repeat(64) });
    expect(pendingAfterCrash.ingestionJobId).toBeUndefined();

    await expect(runIngestion(config, dependencies)).resolves.toMatchObject({
      changed: false,
      ingestionJobId: 'JOB-ACCEPTED'
    });
    expect(startTokens).toEqual(['c'.repeat(64), 'c'.repeat(64)]);
    expect(s3.objects.has(pendingSyncStateKey(config.docsPrefix))).toBe(false);
  });

  it('polls the persisted job without starting another after a completed-marker write crash', async () => {
    const s3 = new MemoryS3();
    let failCompletedWrite = true;
    s3.failPut = key => {
      if (key.includes('/_sync-jobs/') && failCompletedWrite) {
        failCompletedWrite = false;
        return new Error('simulated completed-marker crash');
      }
      return undefined;
    };
    const commandNames: string[] = [];
    const bedrockSend = vi.fn(async (command: unknown) => {
      const name = (command as { constructor: { name: string } }).constructor.name;
      commandNames.push(name);
      return name === 'StartIngestionJobCommand'
        ? { ingestionJob: { ingestionJobId: 'JOB-COMPLETE' } }
        : { ingestionJob: { status: 'COMPLETE' } };
    });
    const dependencies = {
      clone: cloneDependencies(),
      s3,
      bedrock: { send: bedrockSend },
      logger: { info: vi.fn() },
      ...fixedIds()
    };

    await expect(runIngestion(config, dependencies)).rejects.toThrow('completed-marker crash');
    const pendingAfterCrash = JSON.parse(
      s3.objects.get(pendingSyncStateKey(config.docsPrefix))?.body ?? '{}'
    ) as { ingestionJobId?: string };
    expect(pendingAfterCrash.ingestionJobId).toBe('JOB-COMPLETE');

    commandNames.length = 0;
    await expect(runIngestion(config, dependencies)).resolves.toMatchObject({
      ingestionJobId: 'JOB-COMPLETE'
    });
    expect(commandNames).toEqual(['GetIngestionJobCommand']);
    expect(s3.objects.has(pendingSyncStateKey(config.docsPrefix))).toBe(false);
  });
});
