import { loadIngestionConfig } from './config.js';
import { runIngestion } from './pipeline.js';

function errorSummary(error: unknown): Record<string, unknown> {
  if (error instanceof Error) {
    return { name: error.name, message: error.message };
  }
  return { value: String(error) };
}

export async function handler(_event: unknown): Promise<void> {
  try {
    const config = loadIngestionConfig(process.env, { requireBedrockIds: true });
    const result = await runIngestion(config);
    console.log(
      JSON.stringify({
        event: 'lambda_ingestion_completed',
        changed: result.changed,
        upstreamSha: result.manifest.upstreamSha,
        documentCount: result.manifest.documents.length,
        ingestionJobId: result.ingestionJobId
      })
    );
  } catch (error) {
    console.error(JSON.stringify({ event: 'lambda_ingestion_failed', error: errorSummary(error) }));
    throw error;
  }
}
