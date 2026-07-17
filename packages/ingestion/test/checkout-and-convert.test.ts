import { describe, expect, it, vi } from 'vitest';
import { withDocsCheckout } from '../src/clone-docs.js';
import { convertRstToMarkdown } from '../src/convert-rst.js';

const commitSha = 'a'.repeat(40);
const cloneOptions = {
  sourceRepository: 'https://github.com/example/docs.git',
  sourceRef: 'main',
  commandTimeoutMs: 1_000,
  commandMaxOutputBytes: 1_024
};

function successfulGit() {
  return vi.fn(async (_command: string, args: readonly string[]) => ({
    stdout: args.includes('rev-parse') ? `${commitSha}\n` : '',
    stderr: ''
  }));
}

describe('checkout lifecycle', () => {
  it('resolves the exact fetched commit and removes checkout/output after downstream failure', async () => {
    const failure = new Error('conversion failed');
    const removeDirectory = vi.fn(async () => undefined);
    const execute = successfulGit();

    await expect(
      withDocsCheckout(
        cloneOptions,
        async checkout => {
          expect(checkout).toMatchObject({
            commitSha,
            outputPath: '/tmp/smithy-docs-test/converted-output'
          });
          throw failure;
        },
        {
          temporaryRoot: '/tmp',
          makeTemporaryDirectory: vi.fn(async () => '/tmp/smithy-docs-test'),
          removeDirectory,
          execute
        }
      )
    ).rejects.toBe(failure);

    expect(execute.mock.calls.some(call => call[1].includes('--depth=1'))).toBe(true);
    expect(execute.mock.calls.some(call => call[1].includes('sparse-checkout'))).toBe(true);
    expect(removeDirectory).toHaveBeenCalledWith('/tmp/smithy-docs-test', {
      recursive: true,
      force: true
    });
  });

  it('removes a partial checkout when cloning fails', async () => {
    const failure = new Error('git failed');
    const removeDirectory = vi.fn(async () => undefined);

    await expect(
      withDocsCheckout(cloneOptions, async () => undefined, {
        temporaryRoot: '/tmp',
        makeTemporaryDirectory: vi.fn(async () => '/tmp/smithy-docs-test'),
        removeDirectory,
        execute: vi.fn(async () => {
          throw failure;
        })
      })
    ).rejects.toBe(failure);

    expect(removeDirectory).toHaveBeenCalledOnce();
  });
});

describe('RST conversion', () => {
  it('confines generated output, renders stable frontmatter, and bounds concurrency', async () => {
    let active = 0;
    let maximumActive = 0;
    const generated = new Map<string, string>();
    const execute = vi.fn(async (_command: string, args: readonly string[]) => {
      if (args[0] === '--version') {
        return { stdout: 'pandoc 3', stderr: '' };
      }
      active += 1;
      maximumActive = Math.max(maximumActive, active);
      await Promise.resolve();
      const source = String(args[0]);
      const output = String(args.at(-1));
      generated.set(output, `# ${source.includes('a.rst') ? 'Alpha' : 'Beta'}\r\n\r\nBody   \r\n`);
      active -= 1;
      return { stdout: '', stderr: '' };
    });

    const files = await convertRstToMarkdown(
      '/checkout/docs/source-2.0',
      {
        outputPath: '/checkout/converted-output',
        concurrency: 1,
        commandTimeoutMs: 1_000,
        commandMaxOutputBytes: 4_096,
        docsPrefix: 'smithy-docs/'
      },
      {
        findFiles: vi.fn(async () => [
          '/checkout/docs/source-2.0/z/b.rst',
          '/checkout/docs/source-2.0/a.rst'
        ]),
        execute,
        makeDirectory: vi.fn(async () => undefined),
        readTextFile: vi.fn(async path => generated.get(path) ?? ''),
        writeTextFile: vi.fn(async (path, content) => {
          generated.set(path, content);
        }),
        fileSize: vi.fn(async path => Buffer.byteLength(generated.get(path) ?? ''))
      }
    );

    expect(files.map(file => file.relativePath)).toEqual(['a.md', 'z/b.md']);
    expect(maximumActive).toBe(1);
    expect(
      execute.mock.calls
        .filter(call => call[1][0] !== '--version')
        .every(call => String(call[1].at(-1)).startsWith('/checkout/converted-output/'))
    ).toBe(true);
    expect(files[0].content).toBe(
      '---\ntitle: "Alpha"\nsource: "smithy-docs/a.md"\noriginal_format: "rst"\n---\n\n# Alpha\n\nBody\n'
    );
  });

  it('fails on zero documents before starting Pandoc', async () => {
    const execute = vi.fn();
    await expect(
      convertRstToMarkdown(
        '/checkout/docs/source-2.0',
        {
          outputPath: '/checkout/output',
          concurrency: 2,
          commandTimeoutMs: 1_000,
          commandMaxOutputBytes: 1_024
        },
        { findFiles: async () => [], execute }
      )
    ).rejects.toThrow('No RST documentation files');
    expect(execute).not.toHaveBeenCalled();
  });

  it('fails the entire conversion and stops scheduling after a partial failure', async () => {
    const generated = new Map<string, string>();
    const converted: string[] = [];
    const execute = vi.fn(async (_command: string, args: readonly string[]) => {
      if (args[0] === '--version') {
        return { stdout: 'pandoc 3', stderr: '' };
      }
      const source = String(args[0]);
      converted.push(source);
      if (source.endsWith('/b.rst')) {
        throw new Error('bad RST');
      }
      generated.set(String(args.at(-1)), '# OK\n');
      await Promise.resolve();
      return { stdout: '', stderr: '' };
    });

    await expect(
      convertRstToMarkdown(
        '/checkout/docs',
        {
          outputPath: '/checkout/output',
          concurrency: 2,
          commandTimeoutMs: 1_000,
          commandMaxOutputBytes: 1_024
        },
        {
          findFiles: async () => [
            '/checkout/docs/a.rst',
            '/checkout/docs/b.rst',
            '/checkout/docs/c.rst'
          ],
          execute,
          makeDirectory: vi.fn(async () => undefined),
          readTextFile: async path => generated.get(path) ?? '',
          writeTextFile: async () => undefined,
          fileSize: async () => 5
        }
      )
    ).rejects.toThrow('bad RST');
    expect(converted).not.toContain('/checkout/docs/c.rst');
  });
});
