import { describe, expect, it } from 'vitest';
import {
  loadIngestionConfig,
  validateSourceRef,
  validateSourceRepository
} from '../src/config.js';

const environment = {
  BUCKET_NAME: 'docs-bucket',
  KNOWLEDGE_BASE_ID: 'KB12345678',
  DATA_SOURCE_ID: 'DS12345678'
};

describe('ingestion configuration', () => {
  it('loads source, ref, force refresh, and polling only from validated environment values', () => {
    const config = loadIngestionConfig({
      ...environment,
      SOURCE_REPOSITORY: 'https://github.com/example/docs.git',
      SOURCE_REF: 'release/v1.2.3',
      FORCE_REFRESH: 'true',
      INGESTION_POLL_INTERVAL_MS: '1000',
      INGESTION_POLL_MAX_INTERVAL_MS: '8000'
    });

    expect(config).toMatchObject({
      sourceRepository: 'https://github.com/example/docs.git',
      sourceRef: 'release/v1.2.3',
      forceRefresh: true,
      ingestionPollIntervalMs: 1000,
      ingestionPollMaxIntervalMs: 8000
    });
  });

  it.each([
    'file:///tmp/repository',
    'https://user:secret@github.com/example/docs.git',
    'https://localhost/example/docs.git',
    'https://github.com/example/docs.git?ref=main'
  ])('rejects unsafe repository URL %s', (value) => {
    expect(() => validateSourceRepository(value)).toThrow();
  });

  it.each(['--upload-pack=evil', '../main', 'main..other', 'refs/heads/main.lock', 'main @{1}'])(
    'rejects unsafe Git ref %s',
    (value) => {
      expect(() => validateSourceRef(value)).toThrow();
    }
  );

  it.each(['yes', '1', 'TRUE '])('rejects invalid FORCE_REFRESH value %s', (value) => {
    if (value.trim().toLowerCase() === 'true') {
      expect(loadIngestionConfig({ ...environment, FORCE_REFRESH: value }).forceRefresh).toBe(true);
    } else {
      expect(() => loadIngestionConfig({ ...environment, FORCE_REFRESH: value })).toThrow();
    }
  });

  it.each([
    'smithy-mcp-state',
    'smithy-mcp-state/other',
    '/smithy-mcp-staging/',
    'smithy-mcp-staging/run'
  ])('rejects DOCS_PREFIX values that collide with internal namespace %s', (docsPrefix) => {
    expect(() => loadIngestionConfig({ ...environment, DOCS_PREFIX: docsPrefix })).toThrow(
      'DOCS_PREFIX is not a safe S3 prefix'
    );
  });

  it('requires deployment identifiers for Lambda configuration', () => {
    expect(() => loadIngestionConfig({ BUCKET_NAME: 'docs-bucket' })).toThrow(
      'KNOWLEDGE_BASE_ID'
    );
  });

  it('allows the local CLI to omit both Bedrock identifiers, but never just one', () => {
    expect(
      loadIngestionConfig(
        { BUCKET_NAME: 'docs-bucket' },
        { requireBedrockIds: false }
      )
    ).toMatchObject({ knowledgeBaseId: undefined, dataSourceId: undefined });
    expect(() =>
      loadIngestionConfig(
        { BUCKET_NAME: 'docs-bucket', KNOWLEDGE_BASE_ID: 'KB12345678' },
        { requireBedrockIds: false }
      )
    ).toThrow('supplied together');
  });
});
