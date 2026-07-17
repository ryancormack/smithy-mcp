import { describe, expect, it } from 'vitest';
import { runCommand } from '../src/command.js';

describe('bounded shell-free command execution', () => {
  it('passes metacharacters as a literal argument rather than through a shell', async () => {
    const literal = 'value; echo not-a-command';
    const result = await runCommand(
      process.execPath,
      ['-e', 'process.stdout.write(process.argv[1])', literal],
      { timeoutMs: 1_000, maxOutputBytes: 1_024 }
    );

    expect(result.stdout).toBe(literal);
  });

  it('kills commands that exceed the output bound', async () => {
    await expect(
      runCommand(process.execPath, ['-e', 'process.stdout.write("x".repeat(2048))'], {
        timeoutMs: 1_000,
        maxOutputBytes: 128
      })
    ).rejects.toThrow('output limit');
  });

  it('kills commands that exceed the time bound', async () => {
    await expect(
      runCommand(process.execPath, ['-e', 'setInterval(() => undefined, 1000)'], {
        timeoutMs: 25,
        maxOutputBytes: 128
      })
    ).rejects.toThrow('timed out');
  });
});
