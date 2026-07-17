export interface SearchResult {
  content: string;
  location: {
    s3Uri: string;
    type: 'S3';
  };
  score: number;
  metadata?: Record<string, unknown>;
}
