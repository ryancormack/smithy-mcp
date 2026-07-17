import { S3Client } from '@aws-sdk/client-s3';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import type { BedrockSender } from './bedrock.js';
import { startIngestionAndWait } from './bedrock.js';
import type { CloneDocsDependencies } from './clone-docs.js';
import { withDocsCheckout } from './clone-docs.js';
import type { IngestionConfig } from './config.js';
import type { ConvertDependencies } from './convert-rst.js';
import { convertRstToMarkdown } from './convert-rst.js';
import type {
  PublishDependencies,
  PublicationManifest,
  S3Sender
} from './upload-s3.js';
import { publishToS3, readPublicationState } from './upload-s3.js';
import {
  readBedrockSyncState,
  syncStateMatches,
  writeBedrockSyncState
} from './sync-state.js';

export interface IngestionLogger {
  info(summary: Record<string, unknown>): void;
}

export interface RunIngestionDependencies {
  clone?: CloneDocsDependencies;
  convert?: ConvertDependencies;
  publish?: PublishDependencies;
  s3?: S3Sender;
  bedrock?: BedrockSender;
  sleep?: (milliseconds: number) => Promise<void>;
  now?: () => number;
  logger?: IngestionLogger;
}

export interface IngestionResult {
  manifest: PublicationManifest;
  changed: boolean;
  ingestionJobId?: string;
}

const defaultLogger: IngestionLogger = {
  info: (summary) => console.log(JSON.stringify(summary))
};

export async function runIngestion(
  config: IngestionConfig,
  dependencies: RunIngestionDependencies = {}
): Promise<IngestionResult> {
  const logger = dependencies.logger ?? defaultLogger;
  const s3 = dependencies.s3 ?? dependencies.publish?.s3 ?? new S3Client({ maxAttempts: 5 });
  logger.info({
    event: 'ingestion_started',
    sourceRepository: config.sourceRepository,
    sourceRef: config.sourceRef,
    forceRefresh: config.forceRefresh
  });

  const publication = await withDocsCheckout(
    {
      sourceRepository: config.sourceRepository,
      sourceRef: config.sourceRef,
      commandTimeoutMs: config.commandTimeoutMs,
      commandMaxOutputBytes: config.commandMaxOutputBytes
    },
    async (checkout) => {
      logger.info({ event: 'upstream_resolved', upstreamSha: checkout.commitSha });
      const existingState = await readPublicationState(s3, config.bucketName, config.docsPrefix);
      if (
        !config.forceRefresh &&
        existingState?.manifest.sourceRepository === config.sourceRepository &&
        existingState.manifest.upstreamSha === checkout.commitSha
      ) {
        return { manifest: existingState.manifest, changed: false };
      }

      const files = await convertRstToMarkdown(
        join(checkout.docsPath, 'source-2.0'),
        {
          outputPath: checkout.outputPath,
          concurrency: config.conversionConcurrency,
          commandTimeoutMs: config.commandTimeoutMs,
          commandMaxOutputBytes: config.commandMaxOutputBytes,
          docsPrefix: config.docsPrefix
        },
        dependencies.convert
      );
      logger.info({ event: 'conversion_completed', documentCount: files.length });

      return publishToS3(
        files,
        {
          bucketName: config.bucketName,
          prefix: config.docsPrefix,
          sourceRepository: config.sourceRepository,
          sourceRef: config.sourceRef,
          upstreamSha: checkout.commitSha,
          forceRefresh: config.forceRefresh,
          concurrency: config.s3Concurrency
        },
        {
          ...dependencies.publish,
          s3,
          existingState: existingState ?? null
        }
      );
    },
    dependencies.clone
  );

  if (publication.changed) {
    logger.info({
      event: 'publication_completed',
      upstreamSha: publication.manifest.upstreamSha,
      documentCount: publication.manifest.documents.length
    });
  }

  if (config.knowledgeBaseId === undefined || config.dataSourceId === undefined) {
    logger.info({
      event: publication.changed ? 'bedrock_sync_skipped' : 'ingestion_skipped',
      reason: publication.changed ? 'identifiers_not_configured' : 'upstream_sha_unchanged',
      upstreamSha: publication.manifest.upstreamSha,
      documentCount: publication.manifest.documents.length
    });
    return publication;
  }

  if (!publication.changed) {
    const syncState = await readBedrockSyncState(s3, config.bucketName, config.docsPrefix);
    if (syncStateMatches(
      syncState,
      publication.manifest.upstreamSha,
      config.knowledgeBaseId,
      config.dataSourceId
    )) {
      logger.info({
        event: 'ingestion_skipped',
        reason: 'upstream_sha_already_synced',
        upstreamSha: publication.manifest.upstreamSha,
        documentCount: publication.manifest.documents.length,
        ingestionJobId: syncState?.ingestionJobId
      });
      return { ...publication, ingestionJobId: syncState?.ingestionJobId };
    }
    logger.info({
      event: 'bedrock_sync_retry',
      reason: 'publication_not_marked_synced',
      upstreamSha: publication.manifest.upstreamSha
    });
  }

  const ingestionJob = await startIngestionAndWait(
    {
      knowledgeBaseId: config.knowledgeBaseId,
      dataSourceId: config.dataSourceId,
      clientToken: randomUUID(),
      pollIntervalMs: config.ingestionPollIntervalMs,
      maximumPollIntervalMs: config.ingestionPollMaxIntervalMs,
      timeoutMs: config.ingestionTimeoutMs
    },
    {
      bedrock: dependencies.bedrock,
      sleep: dependencies.sleep,
      now: dependencies.now
    }
  );
  await writeBedrockSyncState(s3, config.bucketName, config.docsPrefix, {
    version: 1,
    upstreamSha: publication.manifest.upstreamSha,
    knowledgeBaseId: config.knowledgeBaseId,
    dataSourceId: config.dataSourceId,
    ingestionJobId: ingestionJob.ingestionJobId
  });
  logger.info({ event: 'bedrock_sync_completed', ingestionJobId: ingestionJob.ingestionJobId });

  return {
    ...publication,
    ingestionJobId: ingestionJob.ingestionJobId
  };
}
