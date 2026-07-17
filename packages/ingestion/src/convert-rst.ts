import { readdir, mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { basename, dirname, relative, resolve, sep } from 'node:path';
import { mapWithConcurrency } from './concurrency.js';
import { runCommand, type CommandResult } from './command.js';

export interface MarkdownFile {
  path: string;
  content: string;
  relativePath: string;
  sourceRelativePath: string;
}

export interface ConvertOptions {
  outputPath: string;
  concurrency: number;
  commandTimeoutMs: number;
  commandMaxOutputBytes: number;
  docsPrefix?: string;
}

export interface ConvertDependencies {
  findFiles?: (rootPath: string) => Promise<string[]>;
  makeDirectory?: typeof mkdir;
  readTextFile?: (path: string) => Promise<string>;
  writeTextFile?: (path: string, content: string) => Promise<void>;
  fileSize?: (path: string) => Promise<number>;
  execute?: (
    command: string,
    args: readonly string[],
    options: { cwd?: string; timeoutMs: number; maxOutputBytes: number }
  ) => Promise<CommandResult>;
}

async function findRstFiles(rootPath: string): Promise<string[]> {
  const files: string[] = [];

  async function visit(directory: string): Promise<void> {
    const entries = await readdir(directory, { withFileTypes: true });
    await Promise.all(
      entries.map(async entry => {
        const path = resolve(directory, entry.name);
        if (entry.isDirectory()) {
          await visit(path);
        } else if (entry.isFile() && entry.name.toLowerCase().endsWith('.rst')) {
          files.push(path);
        }
      })
    );
  }

  await visit(rootPath);
  return files.sort();
}

function normalizeRelativePath(rootPath: string, filePath: string): string {
  const value = relative(resolve(rootPath), resolve(filePath)).split(sep).join('/');
  if (value === '' || value === '..' || value.startsWith('../') || value.startsWith('/')) {
    throw new Error(`RST file is outside the documentation root: ${filePath}`);
  }
  return value;
}

function outputFilePath(outputRoot: string, relativePath: string): string {
  const root = resolve(outputRoot);
  const output = resolve(root, relativePath);
  const fromRoot = relative(root, output);
  if (
    fromRoot === '' ||
    fromRoot === '..' ||
    fromRoot.startsWith(`..${sep}`) ||
    fromRoot.startsWith('/')
  ) {
    throw new Error(`Generated path escapes the output directory: ${relativePath}`);
  }
  return output;
}

function normalizeMarkdown(markdown: string): string {
  return `${markdown
    .replace(/\r\n?/g, '\n')
    .replace(/[ \t]+\n/g, '\n')
    .trimEnd()}\n`;
}

function extractTitle(markdown: string, sourceRelativePath: string): string {
  const heading = markdown.split('\n').find(line => /^#{1,6}\s+\S/.test(line));
  if (heading !== undefined) {
    return heading.replace(/^#{1,6}\s+/, '').trim();
  }
  return basename(sourceRelativePath, '.rst');
}

function renderDocument(markdown: string, title: string, source: string): string {
  return [
    '---',
    `title: ${JSON.stringify(title)}`,
    `source: ${JSON.stringify(source)}`,
    'original_format: "rst"',
    '---',
    '',
    markdown
  ].join('\n');
}

export async function convertRstToMarkdown(
  docsPath: string,
  options: ConvertOptions,
  dependencies: ConvertDependencies = {}
): Promise<MarkdownFile[]> {
  const findFiles = dependencies.findFiles ?? findRstFiles;
  const makeDirectory = dependencies.makeDirectory ?? mkdir;
  const readTextFile = dependencies.readTextFile ?? (path => readFile(path, 'utf8'));
  const writeTextFile =
    dependencies.writeTextFile ?? ((path, content) => writeFile(path, content, 'utf8'));
  const fileSize = dependencies.fileSize ?? (async path => (await stat(path)).size);
  const execute = dependencies.execute ?? runCommand;
  const commandOptions = {
    timeoutMs: options.commandTimeoutMs,
    maxOutputBytes: options.commandMaxOutputBytes
  };
  const rstFiles = (await findFiles(docsPath)).sort();
  if (rstFiles.length === 0) {
    throw new Error('No RST documentation files were found');
  }

  await execute('pandoc', ['--version'], commandOptions);
  await makeDirectory(options.outputPath, { recursive: true });
  const prefix = (options.docsPrefix ?? 'smithy-docs/').replace(/\/+$/, '');

  return mapWithConcurrency(rstFiles, options.concurrency, async rstFile => {
    const sourceRelativePath = normalizeRelativePath(docsPath, rstFile);
    const relativePath = sourceRelativePath.replace(/\.rst$/i, '.md');
    const generatedPath = outputFilePath(options.outputPath, relativePath);
    await makeDirectory(dirname(generatedPath), { recursive: true });
    await execute(
      'pandoc',
      [rstFile, '--from=rst', '--to=markdown', '--wrap=none', '--output', generatedPath],
      commandOptions
    );
    const generatedBytes = await fileSize(generatedPath);
    if (generatedBytes > options.commandMaxOutputBytes) {
      throw new Error(
        `Pandoc output exceeded the ${options.commandMaxOutputBytes}-byte limit: ${relativePath}`
      );
    }
    const markdown = normalizeMarkdown(await readTextFile(generatedPath));
    const title = extractTitle(markdown, sourceRelativePath);
    const content = renderDocument(markdown, title, `${prefix}/${relativePath}`);
    await writeTextFile(generatedPath, content);

    return {
      path: rstFile,
      sourceRelativePath,
      relativePath,
      content
    };
  });
}
