import { S3Client, GetObjectCommand } from '@aws-sdk/client-s3';
import { MCPToolResponse } from '../../common/types';

const s3Client = new S3Client({});
const BUCKET_NAME = process.env.BUCKET_NAME!;

export const readToolDefinition = {
  name: 'read_smithy_doc',
  description: 'Read the full content of a specific Smithy documentation file. Use this after searching to get the complete context of a documentation page.',
  inputSchema: {
    type: 'object',
    properties: {
      file_path: {
        type: 'string',
        description: 'The relative path to the documentation file (e.g., "quickstart.md" or "guides/model-basics.md")'
      }
    },
    required: ['file_path']
  }
};

export async function handleReadTool(args: { file_path: string }): Promise<MCPToolResponse> {
  try {
    const cleanPath = args.file_path.replace(/^\/+/, '');
    const key = `smithy-docs/${cleanPath}`;

    const response = await s3Client.send(new GetObjectCommand({ Bucket: BUCKET_NAME, Key: key }));
    const content = await response.Body?.transformToString();

    if (!content) {
      return {
        content: [{ type: 'text', text: `Document found but content is empty: ${args.file_path}` }],
        isError: true
      };
    }

    return { content: [{ type: 'text', text: `# ${args.file_path}\n\n${content}` }] };
  } catch (error: any) {
    if (error.name === 'NoSuchKey') {
      return {
        content: [{ type: 'text', text: `Document not found: ${args.file_path}\n\nTip: Use search_smithy_docs to find available documents.` }],
        isError: true
      };
    }
    return {
      content: [{ type: 'text', text: `Error reading document: ${error instanceof Error ? error.message : 'Unknown error'}` }],
      isError: true
    };
  }
}
