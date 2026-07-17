import { describe, expect, it } from 'vitest';
import { startIngestionAndWait, type BedrockSender } from '../src/bedrock.js';

function commandName(command: unknown): string {
  return (command as { constructor: { name: string } }).constructor.name;
}

const options = {
  knowledgeBaseId: 'KB12345678',
  dataSourceId: 'DS12345678',
  clientToken: '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
  pollIntervalMs: 10,
  maximumPollIntervalMs: 40,
  timeoutMs: 100
};

describe('Bedrock ingestion polling', () => {
  it('polls with bounded backoff until complete and uses the idempotency token', async () => {
    const statuses = ['STARTING', 'IN_PROGRESS', 'IN_PROGRESS', 'COMPLETE'];
    const delays: number[] = [];
    let startInput: Record<string, unknown> | undefined;
    const bedrock: BedrockSender = {
      send: async (command: unknown) => {
        if (commandName(command) === 'StartIngestionJobCommand') {
          startInput = (command as { input: Record<string, unknown> }).input;
          return { ingestionJob: { ingestionJobId: 'JOB123' } };
        }
        return { ingestionJob: { status: statuses.shift() } };
      }
    };

    await expect(
      startIngestionAndWait(options, {
        bedrock,
        sleep: async delay => {
          delays.push(delay);
        }
      })
    ).resolves.toEqual({ ingestionJobId: 'JOB123', status: 'COMPLETE' });
    expect(startInput?.clientToken).toBe(options.clientToken);
    expect(delays).toEqual([10, 20, 40]);
  });

  it('polls a persisted job ID without issuing another start request', async () => {
    const commands: string[] = [];
    const bedrock: BedrockSender = {
      send: async command => {
        commands.push(commandName(command));
        return { ingestionJob: { status: 'COMPLETE' } };
      }
    };

    await expect(
      startIngestionAndWait({ ...options, ingestionJobId: 'JOB-PERSISTED' }, { bedrock })
    ).resolves.toEqual({ ingestionJobId: 'JOB-PERSISTED', status: 'COMPLETE' });
    expect(commands).toEqual(['GetIngestionJobCommand']);
  });

  it.each(['FAILED', 'STOPPING', 'STOPPED', 'MYSTERY'])(
    'fails terminal or unknown status %s',
    async status => {
      const bedrock: BedrockSender = {
        send: async (command: unknown) =>
          commandName(command) === 'StartIngestionJobCommand'
            ? { ingestionJob: { ingestionJobId: 'JOB123' } }
            : { ingestionJob: { status, failureReasons: ['bad source'] } }
      };

      await expect(startIngestionAndWait(options, { bedrock })).rejects.toThrow(status);
    }
  );

  it('bounds an in-flight Bedrock request by the overall timeout', async () => {
    const bedrock: BedrockSender = {
      send: async (command: unknown) => {
        if (commandName(command) === 'StartIngestionJobCommand') {
          return { ingestionJob: { ingestionJobId: 'JOB123' } };
        }
        return new Promise(() => undefined);
      }
    };

    await expect(startIngestionAndWait({ ...options, timeoutMs: 25 }, { bedrock })).rejects.toThrow(
      'timed out'
    );
  });

  it('fails when polling exceeds the bounded timeout', async () => {
    let now = 0;
    const bedrock: BedrockSender = {
      send: async (command: unknown) =>
        commandName(command) === 'StartIngestionJobCommand'
          ? { ingestionJob: { ingestionJobId: 'JOB123' } }
          : { ingestionJob: { status: 'IN_PROGRESS' } }
    };

    await expect(
      startIngestionAndWait(options, {
        bedrock,
        now: () => now,
        sleep: async milliseconds => {
          now += milliseconds;
        }
      })
    ).rejects.toThrow('timed out');
  });
});
