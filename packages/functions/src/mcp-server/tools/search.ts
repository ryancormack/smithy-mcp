import { searchKnowledgeBase } from '../bedrock-client';
import { MCPToolResponse } from '../../common/types';

export const searchToolDefinition = {
  name: 'search_smithy_docs',
  description: 'Search the Smithy CLI documentation using semantic search. Returns relevant documentation snippets with their source locations.',
  inputSchema: {
    type: 'object',
    properties: {
      query: {
        type: 'string',
        description: 'The search query. Can be a question or keywords.'
      },
      max_results: {
        type: 'number',
        description: 'Maximum number of results to return (1-10)',
        default: 5,
        minimum: 1,
        maximum: 10
      }
    },
    required: ['query']
  }
};

export async function handleSearchTool(args: { query: string; max_results?: number }): Promise<MCPToolResponse> {
  try {
    const maxResults = Math.min(args.max_results || 5, 10);
    const results = await searchKnowledgeBase(args.query, maxResults);

    if (results.length === 0) {
      return {
        content: [{ type: 'text', text: 'No relevant documentation found for your query. Try rephrasing or using different keywords.' }]
      };
    }

    let response = `# Search Results for: "${args.query}"\n\nFound ${results.length} relevant section(s):\n\n`;
    results.forEach((result, index) => {
      const fileName = result.location.s3Uri.split('/').pop() || 'unknown';
      response += `## Result ${index + 1} (Score: ${result.score.toFixed(3)})\n**Source:** \`${fileName}\`\n\n${result.content}\n\n---\n\n`;
    });

    return { content: [{ type: 'text', text: response }] };
  } catch (error) {
    return {
      content: [{ type: 'text', text: `Error searching documentation: ${error instanceof Error ? error.message : 'Unknown error'}` }],
      isError: true
    };
  }
}
