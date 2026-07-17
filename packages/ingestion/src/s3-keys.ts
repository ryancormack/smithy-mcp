import { createHash } from 'node:crypto';

const STATE_ROOT = 'smithy-mcp-state';
const STAGING_ROOT = 'smithy-mcp-staging';

function stripBoundarySlashes(prefix: string): string {
  return prefix.replace(/^\/+/, '').replace(/\/+$/, '');
}

export function isReservedInternalPrefix(prefix: string): boolean {
  const normalized = stripBoundarySlashes(prefix);
  return normalized === STATE_ROOT ||
    normalized.startsWith(`${STATE_ROOT}/`) ||
    normalized === STAGING_ROOT ||
    normalized.startsWith(`${STAGING_ROOT}/`);
}

export function normalizeDocsPrefix(prefix: string): string {
  const normalized = stripBoundarySlashes(prefix);
  if (isReservedInternalPrefix(normalized)) {
    throw new Error('Document prefix collides with an internal S3 namespace');
  }
  return `${normalized}/`;
}

export function safePrefixId(prefix: string): string {
  return createHash('sha256').update(normalizeDocsPrefix(prefix), 'utf8').digest('hex');
}

export function publicationStatePrefix(prefix: string): string {
  return `${STATE_ROOT}/${safePrefixId(prefix)}/`;
}

export function publicationStagingPrefix(prefix: string, stageId: string): string {
  return `${STAGING_ROOT}/${safePrefixId(prefix)}/${stageId}/`;
}
