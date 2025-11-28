import simpleGit from 'simple-git';
import { mkdtemp, rm } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';

const SMITHY_REPO = 'https://github.com/smithy-lang/smithy.git';
const DOCS_SUBDIR = 'docs';

export async function cloneDocs(): Promise<string> {
  const tempDir = await mkdtemp(join('./', 'smithy-docs-'));
  
  try {
    const git = simpleGit();
    await git.clone(SMITHY_REPO, tempDir, ['--depth', '1', '--filter=blob:none', '--sparse']);
    
    const repoGit = simpleGit(tempDir);
    await repoGit.raw(['sparse-checkout', 'set', DOCS_SUBDIR]);
    
    return join(tempDir, DOCS_SUBDIR);
  } catch (error) {
    await rm(tempDir, { recursive: true, force: true });
    throw error;
  }
}
