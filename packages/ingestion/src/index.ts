import { join } from 'path';
import { cloneDocs } from './clone-docs.js';
import { convertRstToMarkdown } from './convert-rst.js';
import { uploadToS3 } from './upload-s3.js';

/**
 * Run the full Smithy documentation ingestion pipeline:
 * 1. Clone Smithy repository (sparse checkout of docs)
 * 2. Convert RST files to Markdown
 * 3. Upload Markdown files to S3
 */
export async function runIngestion(bucketName: string, docsPrefix: string): Promise<{ fileCount: number }> {
  console.log('Starting Smithy documentation ingestion...');

  console.log('Step 1: Cloning Smithy repository...');
  const docsPath = await cloneDocs();
  console.log(`Cloned to: ${docsPath}`);

  console.log('Step 2: Converting RST to Markdown...');
  const markdownFiles = await convertRstToMarkdown(join(docsPath, 'source-2.0'));
  console.log(`Converted ${markdownFiles.length} files`);

  console.log('Step 3: Uploading to S3...');
  await uploadToS3(markdownFiles, bucketName, docsPrefix);
  console.log(`Uploaded to s3://${bucketName}/${docsPrefix}`);

  console.log('Ingestion complete!');
  return { fileCount: markdownFiles.length };
}

// CLI entry point - only runs when executed directly
const isMainModule = process.argv[1]?.includes('index');
if (isMainModule) {
  const BUCKET_NAME = process.env.BUCKET_NAME || 'smithy-docs-bucket';
  const DOCS_PREFIX = 'smithy-docs/';

  runIngestion(BUCKET_NAME, DOCS_PREFIX)
    .then(result => {
      console.log(`\nIngestion complete! ${result.fileCount} files processed.`);
      console.log('\nNext steps:');
      console.log('1. Wait for Knowledge Base to sync (may take 5-10 minutes)');
      console.log('2. Test the MCP server with a search query');
    })
    .catch(error => {
      console.error('Error during ingestion:', error);
      process.exit(1);
    });
}
