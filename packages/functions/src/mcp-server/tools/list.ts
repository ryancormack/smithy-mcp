import { S3Client, ListObjectsV2Command } from '@aws-sdk/client-s3';
import { MCPToolResponse } from '../../common/types';

const s3Client = new S3Client({});
const BUCKET_NAME = process.env.BUCKET_NAME!;
const PREFIX = 'smithy-docs/';

export const listToolDefinition = {
  name: 'list_smithy_topics',
  description: 'List all available Smithy documentation topics and files. Returns a structured view of the documentation hierarchy.',
  inputSchema: {
    type: 'object',
    properties: {},
    required: []
  }
};

export async function handleListTool(): Promise<MCPToolResponse> {
  try {
    const response = await s3Client.send(new ListObjectsV2Command({ Bucket: BUCKET_NAME, Prefix: PREFIX }));
    const files = response.Contents || [];

    if (files.length === 0) {
      return { content: [{ type: 'text', text: 'No documentation files found. The knowledge base may not be populated yet.' }] };
    }

    const fileTree: Record<string, string[]> = {};
    files.forEach(file => {
      if (!file.Key) return;
      const relativePath = file.Key.replace(PREFIX, '');
      const parts = relativePath.split('/');
      const dir = parts.length === 1 ? 'Root' : parts.slice(0, -1).join('/');
      if (!fileTree[dir]) fileTree[dir] = [];
      fileTree[dir].push(relativePath);
    });

    let result = `# Smithy Documentation Files\n\nTotal files: ${files.length}\n\n`;
    Object.keys(fileTree).sort().forEach(dir => {
      result += `## ${dir}\n\n`;
      fileTree[dir].forEach(file => result += `- \`${file}\`\n`);
      result += '\n';
    });

    return { content: [{ type: 'text', text: result }] };
  } catch (error) {
    return {
      content: [{ type: 'text', text: `Error listing topics: ${error instanceof Error ? error.message : 'Unknown error'}` }],
      isError: true
    };
  }
}
