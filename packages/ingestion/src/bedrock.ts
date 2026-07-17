import {
  BedrockAgentClient,
  GetIngestionJobCommand,
  StartIngestionJobCommand
} from '@aws-sdk/client-bedrock-agent';

const IN_PROGRESS_STATUSES = new Set(['STARTING', 'IN_PROGRESS']);
const FAILURE_STATUSES = new Set(['FAILED', 'STOPPING', 'STOPPED']);

export interface BedrockSender {
  send(command: unknown, options?: { abortSignal?: AbortSignal }): Promise<unknown>;
}

export interface StartAndWaitOptions {
  knowledgeBaseId: string;
  dataSourceId: string;
  clientToken: string;
  ingestionJobId?: string;
  pollIntervalMs: number;
  maximumPollIntervalMs: number;
  timeoutMs: number;
}

export interface StartAndWaitDependencies {
  bedrock?: BedrockSender;
  sleep?: (milliseconds: number) => Promise<void>;
  now?: () => number;
  onIngestionJobStarted?: (ingestionJobId: string) => Promise<void>;
}

export interface CompletedIngestionJob {
  ingestionJobId: string;
  status: 'COMPLETE';
}

export class BedrockIngestionTerminalError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BedrockIngestionTerminalError';
  }
}

function defaultSleep(milliseconds: number): Promise<void> {
  return new Promise(resolve => {
    setTimeout(resolve, milliseconds);
  });
}

async function sendWithDeadline(
  bedrock: BedrockSender,
  command: unknown,
  deadline: number,
  now: () => number,
  timeoutMessage: string
): Promise<unknown> {
  const remaining = deadline - now();
  if (remaining <= 0) {
    throw new Error(timeoutMessage);
  }

  const controller = new AbortController();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      controller.abort();
      reject(new Error(timeoutMessage));
    }, remaining);

    bedrock.send(command, { abortSignal: controller.signal }).then(
      result => {
        clearTimeout(timer);
        resolve(result);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(
          error instanceof Error ? error : new Error('Bedrock request failed', { cause: error })
        );
      }
    );
  });
}

export async function startIngestionAndWait(
  options: StartAndWaitOptions,
  dependencies: StartAndWaitDependencies = {}
): Promise<CompletedIngestionJob> {
  if (!Number.isInteger(options.pollIntervalMs) || options.pollIntervalMs < 1) {
    throw new Error('Bedrock poll interval must be a positive integer');
  }
  if (
    !Number.isInteger(options.maximumPollIntervalMs) ||
    options.maximumPollIntervalMs < options.pollIntervalMs
  ) {
    throw new Error('Bedrock maximum poll interval must be at least the initial interval');
  }
  if (!Number.isInteger(options.timeoutMs) || options.timeoutMs < 1) {
    throw new Error('Bedrock timeout must be a positive integer');
  }

  const bedrock = dependencies.bedrock ?? new BedrockAgentClient({ maxAttempts: 5 });
  const sleep = dependencies.sleep ?? defaultSleep;
  const now = dependencies.now ?? Date.now;
  const deadline = now() + options.timeoutMs;
  const timeoutMessage = `Bedrock ingestion timed out after ${options.timeoutMs}ms`;

  let ingestionJobId = options.ingestionJobId;
  if (ingestionJobId === undefined) {
    const startResponse = (await sendWithDeadline(
      bedrock,
      new StartIngestionJobCommand({
        knowledgeBaseId: options.knowledgeBaseId,
        dataSourceId: options.dataSourceId,
        clientToken: options.clientToken
      }),
      deadline,
      now,
      timeoutMessage
    )) as { ingestionJob?: { ingestionJobId?: string } };
    ingestionJobId = startResponse.ingestionJob?.ingestionJobId;
    if (ingestionJobId === undefined || ingestionJobId === '') {
      throw new Error('Bedrock did not return an ingestion job ID');
    }
    await dependencies.onIngestionJobStarted?.(ingestionJobId);
  }
  if (ingestionJobId === '') {
    throw new Error('Bedrock ingestion job ID cannot be empty');
  }
  const jobTimeoutMessage = `Bedrock ingestion job ${ingestionJobId} timed out after ${options.timeoutMs}ms`;
  let pollDelay = options.pollIntervalMs;

  while (now() < deadline) {
    const response = (await sendWithDeadline(
      bedrock,
      new GetIngestionJobCommand({
        knowledgeBaseId: options.knowledgeBaseId,
        dataSourceId: options.dataSourceId,
        ingestionJobId
      }),
      deadline,
      now,
      jobTimeoutMessage
    )) as {
      ingestionJob?: {
        status?: string;
        failureReasons?: string[];
      };
    };
    const status = response.ingestionJob?.status;

    if (status === 'COMPLETE') {
      return { ingestionJobId, status };
    }
    if (status !== undefined && FAILURE_STATUSES.has(status)) {
      const reasons = response.ingestionJob?.failureReasons?.join('; ');
      throw new BedrockIngestionTerminalError(
        `Bedrock ingestion job ${ingestionJobId} ended with ${status}${reasons === undefined || reasons === '' ? '' : `: ${reasons}`}`
      );
    }
    if (status === undefined || !IN_PROGRESS_STATUSES.has(status)) {
      throw new Error(
        `Bedrock ingestion job ${ingestionJobId} returned unknown status: ${status ?? 'undefined'}`
      );
    }

    const remaining = deadline - now();
    if (remaining <= 0) {
      break;
    }
    await sleep(Math.min(pollDelay, remaining));
    pollDelay = Math.min(pollDelay * 2, options.maximumPollIntervalMs);
  }

  throw new Error(jobTimeoutMessage);
}
