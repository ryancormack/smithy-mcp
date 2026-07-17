import { spawn } from 'node:child_process';

export interface CommandResult {
  stdout: string;
  stderr: string;
}

export interface CommandOptions {
  cwd?: string;
  timeoutMs: number;
  maxOutputBytes: number;
}

export type SpawnProcess = typeof spawn;

export interface CommandDependencies {
  spawnProcess?: SpawnProcess;
}

export async function runCommand(
  command: string,
  args: readonly string[],
  options: CommandOptions,
  dependencies: CommandDependencies = {}
): Promise<CommandResult> {
  if (!Number.isInteger(options.timeoutMs) || options.timeoutMs < 1) {
    throw new Error('Command timeout must be a positive integer');
  }
  if (!Number.isInteger(options.maxOutputBytes) || options.maxOutputBytes < 1) {
    throw new Error('Command output limit must be a positive integer');
  }

  const spawnProcess = dependencies.spawnProcess ?? spawn;

  return new Promise<CommandResult>((resolve, reject) => {
    const child = spawnProcess(command, [...args], {
      cwd: options.cwd,
      detached: process.platform !== 'win32',
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe']
    });
    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    let outputBytes = 0;
    let settled = false;
    let terminationError: Error | undefined;
    let timer: NodeJS.Timeout | undefined;

    const finish = (error?: Error, result?: CommandResult): void => {
      if (settled) {
        return;
      }
      settled = true;
      if (timer !== undefined) {
        clearTimeout(timer);
      }
      if (error !== undefined) {
        reject(error);
      } else {
        resolve(result ?? { stdout: '', stderr: '' });
      }
    };

    const failAndKill = (error: Error): void => {
      if (terminationError !== undefined) {
        return;
      }
      terminationError = error;
      if (timer !== undefined) {
        clearTimeout(timer);
        timer = undefined;
      }
      if (process.platform !== 'win32' && child.pid !== undefined) {
        try {
          process.kill(-child.pid, 'SIGKILL');
        } catch {
          child.kill('SIGKILL');
        }
      } else {
        child.kill('SIGKILL');
      }
    };

    const collect = (target: Buffer[], chunk: Buffer | string): void => {
      if (settled || terminationError !== undefined) {
        return;
      }
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      outputBytes += buffer.byteLength;
      if (outputBytes > options.maxOutputBytes) {
        failAndKill(new Error(`${command} exceeded the ${options.maxOutputBytes}-byte output limit`));
        return;
      }
      target.push(buffer);
    };

    child.stdout?.on('data', (chunk: Buffer | string) => collect(stdoutChunks, chunk));
    child.stderr?.on('data', (chunk: Buffer | string) => collect(stderrChunks, chunk));
    child.once('error', (error) => finish(terminationError ?? error));
    child.once('close', (code, signal) => {
      if (terminationError !== undefined) {
        finish(terminationError);
        return;
      }
      const stdout = Buffer.concat(stdoutChunks).toString('utf8');
      const stderr = Buffer.concat(stderrChunks).toString('utf8');
      if (code !== 0) {
        const status = signal === null ? `exit code ${code ?? 'unknown'}` : `signal ${signal}`;
        finish(new Error(`${command} failed with ${status}${stderr === '' ? '' : `: ${stderr.trim()}`}`));
        return;
      }
      finish(undefined, { stdout, stderr });
    });

    timer = setTimeout(() => {
      failAndKill(new Error(`${command} timed out after ${options.timeoutMs}ms`));
    }, options.timeoutMs);
    timer.unref();
  });
}
