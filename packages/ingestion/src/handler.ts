import { runIngestion } from './index.js';
import {
  BedrockAgentClient,
  StartIngestionJobCommand,
} from '@aws-sdk/client-bedrock-agent';

const bedrockAgent = new BedrockAgentClient({});

const BUCKET_NAME = process.env.BUCKET_NAME!;
const KNOWLEDGE_BASE_ID = process.env.KNOWLEDGE_BASE_ID!;
const DATA_SOURCE_ID = process.env.DATA_SOURCE_ID!;
const DOCS_PREFIX = 'smithy-docs/';

export async function handler(event: unknown): Promise<{ statusCode: number; body: string }> {
  console.log('Starting scheduled ingestion...', JSON.stringify(event));

  try {
    // Step 1: Run ingestion (clone, convert, upload)
    const result = await runIngestion(BUCKET_NAME, DOCS_PREFIX);
    console.log(`Ingestion complete: ${result.fileCount} files`);

    // Step 2: Trigger Knowledge Base sync
    console.log('Triggering Knowledge Base sync...');
    const syncResponse = await bedrockAgent.send(new StartIngestionJobCommand({
      knowledgeBaseId: KNOWLEDGE_BASE_ID,
      dataSourceId: DATA_SOURCE_ID,
    }));

    console.log('KB sync started:', syncResponse.ingestionJob?.ingestionJobId);

    return {
      statusCode: 200,
      body: JSON.stringify({
        message: 'Ingestion and sync triggered successfully',
        filesProcessed: result.fileCount,
        ingestionJobId: syncResponse.ingestionJob?.ingestionJobId,
      }),
    };
  } catch (error) {
    console.error('Error in scheduled ingestion:', error);
    return {
      statusCode: 500,
      body: JSON.stringify({
        message: 'Ingestion failed',
        error: error instanceof Error ? error.message : 'Unknown error',
      }),
    };
  }
}
