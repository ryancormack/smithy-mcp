import { beforeEach, describe, expect, it, vi } from 'vitest';

const { runIngestion } = vi.hoisted(() => ({ runIngestion: vi.fn() }));
vi.mock('../src/pipeline.js', () => ({ runIngestion }));

import { handler } from '../src/handler.js';

const result = {
  changed: true,
  ingestionJobId: 'JOB123',
  manifest: {
    version: 1,
    sourceRepository: 'https://github.com/smithy-lang/smithy.git',
    sourceRef: 'main',
    upstreamSha: 'a'.repeat(40),
    documents: []
  }
};

describe('Lambda handler', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.BUCKET_NAME = 'docs-bucket';
    process.env.KNOWLEDGE_BASE_ID = 'KB12345678';
    process.env.DATA_SOURCE_ID = 'DS12345678';
    delete process.env.SOURCE_REPOSITORY;
    delete process.env.SOURCE_REPOSITORY_URL;
    delete process.env.SOURCE_REF;
    delete process.env.FORCE_REFRESH;
  });

  it('ignores event source/ref values and uses validated environment only', async () => {
    runIngestion.mockResolvedValue(result);

    await handler({
      sourceRepository: 'https://attacker.example/repository.git',
      sourceRef: '--upload-pack=evil',
      forceRefresh: true
    });

    expect(runIngestion).toHaveBeenCalledOnce();
    expect(runIngestion.mock.calls[0][0]).toMatchObject({
      sourceRepository: 'https://github.com/smithy-lang/smithy.git',
      sourceRef: 'main',
      forceRefresh: false
    });
  });

  it('logs a structured summary and rethrows the exact sync failure', async () => {
    const failure = new Error('Bedrock sync failed');
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    runIngestion.mockRejectedValue(failure);

    await expect(handler({})).rejects.toBe(failure);
    const logged = String(consoleError.mock.calls[0][0]);
    expect(JSON.parse(logged)).toMatchObject({
      event: 'lambda_ingestion_failed',
      error: { name: 'Error', message: 'Bedrock sync failed' }
    });

    consoleError.mockRestore();
  });
});
