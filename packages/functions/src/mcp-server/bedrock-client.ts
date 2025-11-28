import { BedrockAgentRuntimeClient, RetrieveCommand } from '@aws-sdk/client-bedrock-agent-runtime';
import { SearchResult } from '../common/types';

const client = new BedrockAgentRuntimeClient({});
const KNOWLEDGE_BASE_ID = process.env.KNOWLEDGE_BASE_ID!;

export async function searchKnowledgeBase(query: string, maxResults: number = 5): Promise<SearchResult[]> {
  const command = new RetrieveCommand({
    knowledgeBaseId: KNOWLEDGE_BASE_ID,
    retrievalQuery: { text: query },
    retrievalConfiguration: {
      vectorSearchConfiguration: { numberOfResults: maxResults }
    }
  });

  const response = await client.send(command);
  return (response.retrievalResults || []).map(result => ({
    content: result.content?.text || '',
    location: {
      s3Uri: result.location?.s3Location?.uri || '',
      type: 'S3' as const
    },
    score: result.score || 0,
    metadata: result.metadata
  }));
}
