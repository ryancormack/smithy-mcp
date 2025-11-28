export interface SearchResult {
  content: string;
  location: {
    s3Uri: string;
    type: 'S3';
  };
  score: number;
  metadata?: Record<string, any>;
}

export interface MCPToolResponse {
  content: Array<{
    type: 'text';
    text: string;
  }>;
  isError?: boolean;
}
