import { describe, expect, it, vi } from 'vitest';
import type { IngestionConfig } from '../src/config.js';
import { runIngestion } from '../src/pipeline.js';
import { publicationStatePrefix } from '../src/s3-keys.js';

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
const syncStateKey = `${statePrefix}_sync-state.json`;

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

describe('ingestion pipeline', () => {
  it('skips conversion, publication, and Bedrock when the resolved SHA is unchanged', async () => {
    const execute = vi.fn(async (_command: string, args: readonly string[]) => ({
      stdout: args.includes('rev-parse') ? `${commitSha}\n` : '',
      stderr: ''
    }));
    const bedrockSend = vi.fn(async () => {
      throw new Error('Bedrock must not be called');
    });
    const convertExecute = vi.fn(async () => {
      throw new Error('Pandoc must not be called');
    });
    const removeDirectory = vi.fn(async () => undefined);
    const s3Send = vi.fn(async (command: unknown) => {
      const value = command as { constructor: { name: string }; input: { Key?: string } };
      const name = value.constructor.name;
      if (name !== 'GetObjectCommand') {
        throw new Error(`Unexpected S3 command: ${name}`);
      }
      if (value.input.Key === manifestKey) {
        return { Body: JSON.stringify(manifest), ETag: '"manifest-etag"' };
      }
      if (value.input.Key === syncStateKey) {
        return {
          Body: JSON.stringify({
            version: 1,
            upstreamSha: commitSha,
            knowledgeBaseId: config.knowledgeBaseId,
            dataSourceId: config.dataSourceId,
            ingestionJobId: 'JOB123'
          })
        };
      }
      throw new Error(`Unexpected S3 key: ${value.input.Key}`);
    });

    const result = await runIngestion(config, {
      clone: {
        makeTemporaryDirectory: vi.fn(async () => '/tmp/smithy-docs-test'),
        removeDirectory,
        execute
      },
      convert: { execute: convertExecute },
      s3: { send: s3Send },
      bedrock: { send: bedrockSend },
      logger: { info: vi.fn() }
    });

    expect(result).toEqual({ manifest, changed: false, ingestionJobId: 'JOB123' });
    expect(convertExecute).not.toHaveBeenCalled();
    expect(bedrockSend).not.toHaveBeenCalled();
    expect(s3Send).toHaveBeenCalledTimes(2);
    expect(removeDirectory).toHaveBeenCalledOnce();
  });

  it('retries Bedrock for an unchanged publication that lacks a completed sync marker', async () => {
    const execute = vi.fn(async (_command: string, args: readonly string[]) => ({
      stdout: args.includes('rev-parse') ? `${commitSha}\n` : '',
      stderr: ''
    }));
    const s3Calls: Array<{ name: string; key?: string }> = [];
    const s3Send = vi.fn(async (command: unknown) => {
      const value = command as { constructor: { name: string }; input: { Key?: string } };
      const name = value.constructor.name;
      s3Calls.push({ name, key: value.input.Key });
      if (name === 'GetObjectCommand' && value.input.Key === manifestKey) {
        return { Body: JSON.stringify(manifest), ETag: '"manifest-etag"' };
      }
      if (name === 'GetObjectCommand' && value.input.Key === syncStateKey) {
        throw Object.assign(new Error('missing'), { name: 'NoSuchKey' });
      }
      if (name === 'PutObjectCommand' && value.input.Key === syncStateKey) {
        return {};
      }
      throw new Error(`Unexpected S3 command: ${name} ${value.input.Key ?? ''}`);
    });
    const bedrockSend = vi.fn(async (command: unknown) => {
      const name = (command as { constructor: { name: string } }).constructor.name;
      return name === 'StartIngestionJobCommand'
        ? { ingestionJob: { ingestionJobId: 'JOB-RETRY' } }
        : { ingestionJob: { status: 'COMPLETE' } };
    });

    const result = await runIngestion(config, {
      clone: {
        makeTemporaryDirectory: vi.fn(async () => '/tmp/smithy-docs-test'),
        removeDirectory: vi.fn(async () => undefined),
        execute
      },
      s3: { send: s3Send },
      bedrock: { send: bedrockSend },
      logger: { info: vi.fn() }
    });

    expect(result).toEqual({ manifest, changed: false, ingestionJobId: 'JOB-RETRY' });
    expect(bedrockSend).toHaveBeenCalledTimes(2);
    expect(s3Calls).toContainEqual({ name: 'PutObjectCommand', key: syncStateKey });
    expect(syncStateKey.startsWith(config.docsPrefix)).toBe(false);
  });
});
