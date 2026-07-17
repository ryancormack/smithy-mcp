import { beforeEach, describe, expect, it, vi } from 'vitest';

const { runIngestion } = vi.hoisted(() => ({ runIngestion: vi.fn() }));
vi.mock('../src/pipeline.js', () => ({ runIngestion }));

import { runCli } from '../src/cli.js';

const environment = {
  BUCKET_NAME: 'docs-bucket',
  SOURCE_REPOSITORY: 'https://github.com/example/docs.git',
  SOURCE_REF: 'release/v1'
};
const result = {
  changed: true,
  manifest: {
    version: 1,
    sourceRepository: environment.SOURCE_REPOSITORY,
    sourceRef: environment.SOURCE_REF,
    upstreamSha: 'a'.repeat(40),
    documents: []
  }
};

describe('local ingestion CLI', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('publishes without Bedrock when IDs are omitted', async () => {
    runIngestion.mockResolvedValue(result);

    await runCli(environment);

    expect(runIngestion).toHaveBeenCalledOnce();
    expect(runIngestion.mock.calls[0][0]).toMatchObject({
      bucketName: 'docs-bucket',
      knowledgeBaseId: undefined,
      dataSourceId: undefined,
      sourceRepository: 'https://github.com/example/docs.git',
      sourceRef: 'release/v1'
    });
  });

  it('propagates pipeline failures without calling process.exit', async () => {
    const failure = new Error('ingestion failed');
    const processExit = vi.spyOn(process, 'exit');
    runIngestion.mockRejectedValue(failure);

    await expect(runCli(environment)).rejects.toBe(failure);
    expect(processExit).not.toHaveBeenCalled();

    processExit.mockRestore();
  });

  it('still requires BUCKET_NAME and paired Bedrock IDs', async () => {
    await expect(runCli({})).rejects.toThrow('BUCKET_NAME');
    await expect(runCli({ BUCKET_NAME: 'docs-bucket', KNOWLEDGE_BASE_ID: 'KB12345678' }))
      .rejects.toThrow('supplied together');
  });
});
