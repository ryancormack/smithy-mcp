import { pathToFileURL } from 'node:url';
import { loadIngestionConfig } from './config.js';
import { runIngestion } from './pipeline.js';

export async function runCli(environment: NodeJS.ProcessEnv = process.env): Promise<void> {
  const config = loadIngestionConfig(environment, { requireBedrockIds: false });
  const result = await runIngestion(config);
  console.log(
    JSON.stringify({
      event: 'cli_ingestion_completed',
      changed: result.changed,
      upstreamSha: result.manifest.upstreamSha,
      documentCount: result.manifest.documents.length,
      ingestionJobId: result.ingestionJobId
    })
  );
}

function isDirectExecution(): boolean {
  const entryPoint = process.argv.at(1);
  return entryPoint !== undefined && import.meta.url === pathToFileURL(entryPoint).href;
}

if (isDirectExecution()) {
  runCli().catch((error: unknown) => {
    const summary =
      error instanceof Error
        ? { name: error.name, message: error.message }
        : { value: String(error) };
    console.error(JSON.stringify({ event: 'cli_ingestion_failed', error: summary }));
    process.exitCode = 1;
  });
}
