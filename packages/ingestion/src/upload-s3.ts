import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';
import { MarkdownFile } from './convert-rst.js';

const s3Client = new S3Client({});

export async function uploadToS3(files: MarkdownFile[], bucketName: string, prefix: string): Promise<void> {
  console.log(`Uploading ${files.length} files to s3://${bucketName}/${prefix}`);
  
  const uploads = files.map(async (file) => {
    const key = `${prefix}${file.relativePath}`;
    
    try {
      await s3Client.send(new PutObjectCommand({
        Bucket: bucketName,
        Key: key,
        Body: file.content,
        ContentType: 'text/markdown',
        Metadata: {
          'source-file': file.path,
          'format': 'markdown'
        }
      }));
      console.log(`  ✓ Uploaded: ${key}`);
    } catch (error) {
      console.error(`  ✗ Failed to upload ${key}:`, error);
      throw error;
    }
  });
  
  await Promise.all(uploads);
}
