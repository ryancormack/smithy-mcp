import { join } from 'path';
import { cloneDocs } from './clone-docs.js';
import { convertRstToMarkdown } from './convert-rst.js';
import { uploadToS3 } from './upload-s3.js';

const BUCKET_NAME = process.env.BUCKET_NAME || 'smithy-docs-bucket';
const DOCS_PREFIX = 'smithy-docs/';

async function main() {
  console.log('Starting Smithy documentation ingestion...');
  
  try {
    console.log('Step 1: Cloning Smithy repository...');
    const docsPath = await cloneDocs();
    console.log(`✓ Cloned to: ${docsPath}`);
    
    console.log('Step 2: Converting RST to Markdown...');
    const markdownFiles = await convertRstToMarkdown(join(docsPath, 'source-2.0'));
    console.log(`✓ Converted ${markdownFiles.length} files`);
    
    console.log('Step 3: Uploading to S3...');
    await uploadToS3(markdownFiles, BUCKET_NAME, DOCS_PREFIX);
    console.log(`✓ Uploaded to s3://${BUCKET_NAME}/${DOCS_PREFIX}`);
    
    console.log('\n✓ Ingestion complete!');
    console.log('\nNext steps:');
    console.log('1. Wait for Knowledge Base to sync (may take 5-10 minutes)');
    console.log('2. Test the MCP server with a search query');
  } catch (error) {
    console.error('Error during ingestion:', error);
    process.exit(1);
  }
}

main();
