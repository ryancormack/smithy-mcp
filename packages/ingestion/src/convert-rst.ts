import { glob } from 'glob';
import { relative, basename } from 'path';
import { exec } from 'child_process';
import { promisify } from 'util';
import matter from 'gray-matter';

const execAsync = promisify(exec);

export interface MarkdownFile {
  path: string;
  content: string;
  relativePath: string;
}

export async function convertRstToMarkdown(docsPath: string): Promise<MarkdownFile[]> {
  const rstFiles = await glob('**/*.rst', { cwd: docsPath, absolute: true });
  console.log(`Found ${rstFiles.length} RST files to convert`);
  
  try {
    await execAsync('pandoc --version');
  } catch {
    throw new Error('Pandoc is required. Install: brew install pandoc (macOS) or apt-get install pandoc (Linux)');
  }
  
  const markdownFiles: MarkdownFile[] = [];
  
  for (const rstFile of rstFiles) {
    try {
      const { stdout } = await execAsync(`pandoc "${rstFile}" -f rst -t markdown --wrap=none`);
      const relativePath = relative(docsPath, rstFile).replace(/\.rst$/, '.md');
      const lines = stdout.split('\n');
      const firstHeading = lines.find(l => l.startsWith('#'));
      const title = firstHeading ? firstHeading.replace(/^#+\s*/, '').trim() : basename(rstFile, '.rst');
      
      const contentWithMeta = matter.stringify(stdout, {
        title,
        source: `smithy-docs/${relativePath}`,
        original_format: 'rst'
      });
      
      markdownFiles.push({ path: rstFile, content: contentWithMeta, relativePath });
      console.log(`  ✓ Converted: ${relativePath}`);
    } catch (error) {
      console.error(`  ✗ Failed to convert ${rstFile}:`, error);
    }
  }
  
  return markdownFiles;
}
