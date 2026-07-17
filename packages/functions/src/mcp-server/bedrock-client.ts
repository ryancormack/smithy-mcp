import {
  type BedrockAgentRuntimeClient,
  RetrieveCommand
} from '@aws-sdk/client-bedrock-agent-runtime';
import { type SearchResult } from '../common/types';

export async function searchKnowledgeBase(
  client: BedrockAgentRuntimeClient,
  knowledgeBaseId: string,
  query: string,
  maxResults: number = 5
): Promise<SearchResult[]> {
  const command = new RetrieveCommand({
    knowledgeBaseId,
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
