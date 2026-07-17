import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runCommand, type CommandResult } from './command.js';

const DOCS_SUBDIRECTORY = 'docs';

export interface DocsCheckout {
  rootPath: string;
  docsPath: string;
  outputPath: string;
  commitSha: string;
}

export interface CloneDocsOptions {
  sourceRepository: string;
  sourceRef: string;
  commandTimeoutMs: number;
  commandMaxOutputBytes: number;
}

export interface CloneDocsDependencies {
  makeTemporaryDirectory?: typeof mkdtemp;
  removeDirectory?: typeof rm;
  temporaryRoot?: string;
  execute?: (
    command: string,
    args: readonly string[],
    options: { cwd?: string; timeoutMs: number; maxOutputBytes: number }
  ) => Promise<CommandResult>;
}

export async function removeDocsCheckout(
  checkout: DocsCheckout,
  dependencies: Pick<CloneDocsDependencies, 'removeDirectory'> = {}
): Promise<void> {
  await (dependencies.removeDirectory ?? rm)(checkout.rootPath, { recursive: true, force: true });
}

export async function createDocsCheckout(
  options: CloneDocsOptions,
  dependencies: CloneDocsDependencies = {}
): Promise<DocsCheckout> {
  const makeTemporaryDirectory = dependencies.makeTemporaryDirectory ?? mkdtemp;
  const removeDirectory = dependencies.removeDirectory ?? rm;
  const execute = dependencies.execute ?? runCommand;
  const rootPath = await makeTemporaryDirectory(
    join(dependencies.temporaryRoot ?? tmpdir(), 'smithy-docs-')
  );
  const commandOptions = {
    timeoutMs: options.commandTimeoutMs,
    maxOutputBytes: options.commandMaxOutputBytes
  };

  try {
    await execute('git', ['-C', rootPath, 'init'], commandOptions);
    await execute(
      'git',
      ['-C', rootPath, 'remote', 'add', 'origin', options.sourceRepository],
      commandOptions
    );
    await execute('git', ['-C', rootPath, 'sparse-checkout', 'init', '--cone'], commandOptions);
    await execute(
      'git',
      ['-C', rootPath, 'sparse-checkout', 'set', '--', DOCS_SUBDIRECTORY],
      commandOptions
    );
    await execute(
      'git',
      [
        '-C',
        rootPath,
        'fetch',
        '--depth=1',
        '--filter=blob:none',
        '--no-tags',
        'origin',
        options.sourceRef
      ],
      commandOptions
    );
    await execute('git', ['-C', rootPath, 'checkout', '--detach', 'FETCH_HEAD'], commandOptions);
    const resolved = await execute(
      'git',
      ['-C', rootPath, 'rev-parse', '--verify', 'HEAD'],
      commandOptions
    );
    const commitSha = resolved.stdout.trim().toLowerCase();
    if (!/^[0-9a-f]{40,64}$/.test(commitSha)) {
      throw new Error('Git returned an invalid commit SHA');
    }

    return {
      rootPath,
      docsPath: join(rootPath, DOCS_SUBDIRECTORY),
      outputPath: join(rootPath, 'converted-output'),
      commitSha
    };
  } catch (error) {
    await removeDirectory(rootPath, { recursive: true, force: true });
    throw error;
  }
}

export async function withDocsCheckout<T>(
  options: CloneDocsOptions,
  operation: (checkout: DocsCheckout) => Promise<T>,
  dependencies: CloneDocsDependencies = {}
): Promise<T> {
  const checkout = await createDocsCheckout(options, dependencies);
  try {
    return await operation(checkout);
  } finally {
    await removeDocsCheckout(checkout, dependencies);
  }
}
