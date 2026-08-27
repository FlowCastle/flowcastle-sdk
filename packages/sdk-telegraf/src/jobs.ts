import type { AsyncLocalStorage } from 'node:async_hooks';

import type { Telegram } from 'telegraf';

const ALLOWED_JOB_METHODS: ReadonlySet<string> = new Set([
  'sendMessage',
  'sendPhoto',
  'sendDocument',
  'sendChatAction',
  'answerCallbackQuery',
]);
const POLL_WAIT_MS = 25_000;
const POLL_MAX = 10;
const POLL_CLIENT_TIMEOUT_MS = POLL_WAIT_MS + 5_000;

interface Job {
  id: string;
  leaseToken: string;
  method: string;
  params: Record<string, unknown>;
}

interface AckResult {
  id: string;
  leaseToken: string;
  ok: boolean;
  error?: { code?: number; description: string };
  errorCode?: number;
  errorDescription?: string;
  result?: { messageId?: number };
}

export interface JobPullerOptions {
  apiKey: string;
  apiUrl: string;
  onError: (error: unknown) => void;
  jobContext: AsyncLocalStorage<string>;
  onJobDelivered?: (chatId: number | string) => void;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function extractChatId(params: Record<string, unknown>): number | string | undefined {
  const value = params.chat_id;
  return typeof value === 'number' || typeof value === 'string' ? value : undefined;
}

function errorDetails(error: unknown): { errorCode?: number; errorDescription?: string } {
  if (!isObject(error)) return {};
  return {
    ...(typeof error.error_code === 'number' ? { errorCode: error.error_code } : {}),
    ...(typeof error.description === 'string' ? { errorDescription: error.description } : {}),
  };
}

function messageId(result: unknown): number | undefined {
  return isObject(result) && typeof result.message_id === 'number' ? result.message_id : undefined;
}

/** Pulls protocol-v2 jobs through the host's own Telegraf transport. */
export class JobPuller {
  private telegram: Telegram | undefined;
  private started = false;
  private running = true;
  private controller: AbortController | undefined;

  public constructor(private readonly options: JobPullerOptions) {}

  public setTelegram(telegram: Telegram): void {
    this.telegram = telegram;
    if (!this.started && this.running) {
      this.started = true;
      void this.loop();
    }
  }

  public destroy(): void {
    this.running = false;
    this.controller?.abort();
  }

  private async loop(): Promise<void> {
    while (this.running && this.telegram !== undefined) {
      try {
        const jobs = await this.poll();
        if (jobs.length === 0) continue;
        const results: AckResult[] = [];
        for (const job of jobs) results.push(await this.execute(this.telegram, job));
        await this.ack(results);
      } catch (error) {
        if (this.running) this.options.onError(error);
        if (this.running) await this.delay(1_000);
      }
    }
  }

  private async execute(telegram: Telegram, job: Job): Promise<AckResult> {
    if (!ALLOWED_JOB_METHODS.has(job.method)) {
      this.options.onError(new Error(`FlowCastle: refused disallowed job method '${job.method}'`));
      return {
        id: job.id,
        leaseToken: job.leaseToken,
        ok: false,
        error: { code: 400, description: 'method not allowed' },
        errorCode: 400,
        errorDescription: 'method not allowed',
      };
    }
    try {
      const result = await this.options.jobContext.run(job.id, () => this.dispatch(telegram, job));
      const chatId = extractChatId(job.params);
      if (chatId !== undefined) this.options.onJobDelivered?.(chatId);
      const id = messageId(result);
      return {
        id: job.id,
        leaseToken: job.leaseToken,
        ok: true,
        ...(id === undefined ? {} : { result: { messageId: id } }),
      };
    } catch (error) {
      this.options.onError(error);
      const details = errorDetails(error);
      return {
        id: job.id,
        leaseToken: job.leaseToken,
        ok: false,
        error: { ...(details.errorCode === undefined ? {} : { code: details.errorCode }), description: details.errorDescription ?? 'Telegram request failed' },
        ...details,
      };
    }
  }

  /** Explicit cases retain a local allowlist even if server input is compromised. */
  private async dispatch(telegram: Telegram, job: Job): Promise<unknown> {
    switch (job.method) {
      case 'sendMessage': return telegram.callApi('sendMessage', job.params as never);
      case 'sendPhoto': return telegram.callApi('sendPhoto', job.params as never);
      case 'sendDocument': return telegram.callApi('sendDocument', job.params as never);
      case 'sendChatAction': return telegram.callApi('sendChatAction', job.params as never);
      case 'answerCallbackQuery': return telegram.callApi('answerCallbackQuery', job.params as never);
      default: throw new Error(`FlowCastle: unsupported job method '${job.method}'`);
    }
  }

  private async poll(): Promise<Job[]> {
    this.controller = new AbortController();
    const timeout = setTimeout(() => this.controller?.abort(), POLL_CLIENT_TIMEOUT_MS);
    if (typeof timeout.unref === 'function') timeout.unref();
    try {
      const query = new URLSearchParams({
        protocolVersion: '2',
        waitMs: String(POLL_WAIT_MS),
        max: String(POLL_MAX),
      });
      for (const method of ALLOWED_JOB_METHODS) query.append('capability', `transport.telegram.bot_api.${method}`);
      const response = await fetch(`${this.options.apiUrl}/api/sdk/v1/jobs?${query.toString()}`, {
        headers: { Authorization: `Bearer ${this.options.apiKey}` },
        signal: this.controller.signal,
      });
      if (!response.ok) throw new Error(`FlowCastle: jobs poll failed (${response.status})`);
      return parseJobs(await response.json());
    } finally {
      clearTimeout(timeout);
      this.controller = undefined;
    }
  }

  private async ack(results: AckResult[]): Promise<void> {
    if (results.length === 0) return;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        const response = await fetch(`${this.options.apiUrl}/api/sdk/v1/jobs/ack`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${this.options.apiKey}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ protocolVersion: 2, results }),
        });
        if (!response.ok) throw new Error(`FlowCastle: jobs ack failed (${response.status})`);
        return;
      } catch (error) {
        if (attempt === 0) continue;
        throw error;
      }
    }
  }

  private delay(ms: number): Promise<void> {
    return new Promise((resolve) => {
      const timer = setTimeout(resolve, ms);
      if (typeof timer.unref === 'function') timer.unref();
    });
  }
}

function parseJobs(value: unknown): Job[] {
  if (!isObject(value) || !Array.isArray(value.jobs)) return [];
  return value.jobs.flatMap((job): Job[] => {
    if (!isObject(job)
      || typeof job.id !== 'string'
      || typeof job.leaseToken !== 'string'
      || job.leaseToken.length === 0) return [];
    const method = typeof job.operation === 'string' ? job.operation : job.method;
    if (typeof method !== 'string') return [];
    return [{
      id: job.id,
      leaseToken: job.leaseToken,
      method,
      params: isObject(job.params) ? job.params : {},
    }];
  });
}
