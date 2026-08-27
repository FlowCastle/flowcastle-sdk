import type { AsyncLocalStorage } from 'node:async_hooks';

import type { Api } from 'grammy';

/**
 * Methods the plugin is willing to execute on behalf of the server. This is the
 * security boundary: the PLUGIN — not the server — decides what may run inside
 * the host bot. Any pulled job whose `method` is not in this set is refused
 * (acked `ok:false, errorCode:400`) and never dispatched, regardless of what the
 * server sends. Keep this list minimal and explicit.
 */
const ALLOWED_JOB_METHODS: ReadonlySet<string> = new Set([
  'sendMessage',
  'sendPhoto',
  'sendDocument',
  'sendChatAction',
  'answerCallbackQuery',
]);

/** Server long-poll hold window (ms) requested via the `waitMs` query param. */
const POLL_WAIT_MS = 25000;
/** Max jobs requested per poll. */
const POLL_MAX = 10;
/** Client-side abort budget: the server holds for `waitMs`, we allow 5s of slack. */
const POLL_CLIENT_TIMEOUT_MS = POLL_WAIT_MS + 5000;
/** Transport-error backoff bounds. */
const INITIAL_BACKOFF_MS = 1000;
const MAX_BACKOFF_MS = 30000;

/** A delivery job pulled from FlowCastle. */
interface Job {
  id: string;
  leaseToken: string;
  method: string;
  params: Record<string, unknown>;
}

/** One entry in the ack request body. */
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
  /** Normalized base URL (no trailing slash). */
  apiUrl: string;
  onError: (error: unknown) => void;
  /**
   * Per-plugin store holding the id of the job currently executing. The
   * transformer reads it to stamp `correlationJobId` on the resulting outgoing
   * event, letting the server tell agent-reply sends apart from the bot's own.
   */
  jobContext: AsyncLocalStorage<string>;
  /**
   * Called with the job's `chat_id` after a job with one is executed
   * successfully. Wired to the live-agent window so a delivered agent reply
   * (re)opens the local live-agent-active window for that chat. Optional.
   */
  onJobDelivered?: (chatId: number | string) => void;
}

// Typed payload targets for each allowlisted method. Sourced from grammY's raw
// API so the dispatch stays statically typed and enumerable — never a dynamic
// `obj[method](...)` on an unknown object.
type SendMessagePayload = Parameters<Api['raw']['sendMessage']>[0];
type SendPhotoPayload = Parameters<Api['raw']['sendPhoto']>[0];
type SendDocumentPayload = Parameters<Api['raw']['sendDocument']>[0];
type SendChatActionPayload = Parameters<Api['raw']['sendChatAction']>[0];
type AnswerCallbackQueryPayload = Parameters<Api['raw']['answerCallbackQuery']>[0];

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

/** Extract a `chat_id` (number|string) from a job's params, if present. */
function extractChatId(params: Record<string, unknown>): number | string | undefined {
  const value = params.chat_id;
  if (typeof value === 'number' || typeof value === 'string') {
    return value;
  }
  return undefined;
}

/** Pull `error_code`/`description` off a GrammyError-shaped throw (duck-typed). */
function extractGrammyError(error: unknown): { errorCode?: number; errorDescription?: string } {
  const out: { errorCode?: number; errorDescription?: string } = {};
  if (isObject(error)) {
    if (typeof error.error_code === 'number') {
      out.errorCode = error.error_code;
    }
    if (typeof error.description === 'string') {
      out.errorDescription = error.description;
    }
  }
  return out;
}

interface PendingDelay {
  timer: ReturnType<typeof setTimeout>;
  resolve: () => void;
}

/**
 * Phase-2 pull channel. Long-polls FlowCastle for outbound delivery jobs (Live
 * Chat agent replies) and executes the allowlisted ones through the host bot's
 * own grammY `Api` — the same instance the transformer observes, so executed
 * sends surface as normal `outgoing` events (intended).
 *
 * Lifecycle:
 * - Constructed idle. Polls nothing until {@link setApi} supplies the grammY
 *   `Api` captured from the first update (so it only polls when it can execute).
 * - Runs a single loop: long-poll GET /jobs → dispatch each job sequentially →
 *   POST /jobs/ack. Empty result loops immediately; a transport error backs off
 *   exponentially (1s→30s, reset on success). The loop never throws — every
 *   failure is routed to `onError`.
 * - {@link destroy} stops the loop and aborts any in-flight long-poll.
 */
export class JobPuller {
  private readonly apiKey: string;
  private readonly apiUrl: string;
  private readonly onError: (error: unknown) => void;
  private readonly jobContext: AsyncLocalStorage<string>;
  private readonly onJobDelivered: ((chatId: number | string) => void) | undefined;

  private api: Api | undefined;
  private running = true;
  private started = false;
  private backoffMs = INITIAL_BACKOFF_MS;
  private pollController: AbortController | undefined;
  private pendingDelay: PendingDelay | undefined;

  constructor(options: JobPullerOptions) {
    this.apiKey = options.apiKey;
    this.apiUrl = options.apiUrl;
    this.onError = options.onError;
    this.jobContext = options.jobContext;
    this.onJobDelivered = options.onJobDelivered;
  }

  /**
   * Supply the grammY `Api` to execute jobs through. Starts the poll loop on the
   * first call; subsequent calls only refresh the reference. Idempotent.
   */
  setApi(api: Api): void {
    this.api = api;
    if (!this.started && this.running) {
      this.started = true;
      void this.loop();
    }
  }

  /** Stop the loop and abort any in-flight long-poll or backoff wait. */
  destroy(): void {
    this.running = false;
    if (this.pollController !== undefined) {
      this.pollController.abort();
    }
    if (this.pendingDelay !== undefined) {
      const { timer, resolve } = this.pendingDelay;
      this.pendingDelay = undefined;
      clearTimeout(timer);
      resolve();
    }
  }

  private async loop(): Promise<void> {
    while (this.running && this.api !== undefined) {
      const api = this.api;
      let jobs: Job[];
      try {
        jobs = await this.poll();
      } catch (error) {
        // A destroy()-driven abort lands here too; exit quietly without reporting.
        if (!this.running) {
          return;
        }
        this.onError(error);
        await this.delay(this.backoffMs);
        this.backoffMs = Math.min(this.backoffMs * 2, MAX_BACKOFF_MS);
        continue;
      }

      // Successful poll (even if empty) resets the transport backoff.
      this.backoffMs = INITIAL_BACKOFF_MS;
      if (jobs.length === 0) {
        continue;
      }

      const results: AckResult[] = [];
      for (const job of jobs) {
        results.push(await this.execute(api, job));
      }
      await this.ack(results);
    }
  }

  /** Execute one job, returning its ack entry. Never throws. */
  private async execute(api: Api, job: Job): Promise<AckResult> {
    if (!ALLOWED_JOB_METHODS.has(job.method)) {
      this.onError(new Error(`FlowCastle: refused disallowed job method '${job.method}'`));
      return { id: job.id, leaseToken: job.leaseToken, ok: false, error: { code: 400, description: 'method not allowed' }, errorCode: 400, errorDescription: 'method not allowed' };
    }
    try {
      // Run the send inside the job-id scope so the transformer can stamp
      // `correlationJobId` on the resulting outgoing event (echo-loop guard).
      const outcome = await this.jobContext.run(job.id, () => this.dispatch(api, job));
      // Delivered agent reply → refresh the local live-agent window for its chat.
      if (this.onJobDelivered !== undefined) {
        const chatId = extractChatId(job.params);
        if (chatId !== undefined) {
          try {
            this.onJobDelivered(chatId);
          } catch (error) {
            this.onError(error);
          }
        }
      }
      const result: AckResult = { id: job.id, leaseToken: job.leaseToken, ok: true };
      if (outcome.messageId !== undefined) {
        result.result = { messageId: outcome.messageId };
      }
      return result;
    } catch (error) {
      this.onError(error);
      const { errorCode, errorDescription } = extractGrammyError(error);
      const result: AckResult = { id: job.id, leaseToken: job.leaseToken, ok: false };
      if (errorCode !== undefined) {
        result.errorCode = errorCode;
      }
      if (errorDescription !== undefined) {
        result.errorDescription = errorDescription;
      }
      result.error = {
        ...(errorCode === undefined ? {} : { code: errorCode }),
        description: errorDescription ?? 'Telegram operation failed',
      };
      return result;
    }
  }

  /**
   * Statically-typed dispatch: one case per allowlisted method, each calling the
   * corresponding grammY raw method with the job params. No dynamic indexing.
   */
  private async dispatch(api: Api, job: Job): Promise<{ messageId?: number }> {
    const params = job.params;
    switch (job.method) {
      case 'sendMessage': {
        const message = await api.raw.sendMessage(params as unknown as SendMessagePayload);
        return { messageId: message.message_id };
      }
      case 'sendPhoto': {
        const message = await api.raw.sendPhoto(params as unknown as SendPhotoPayload);
        return { messageId: message.message_id };
      }
      case 'sendDocument': {
        const message = await api.raw.sendDocument(params as unknown as SendDocumentPayload);
        return { messageId: message.message_id };
      }
      case 'sendChatAction': {
        await api.raw.sendChatAction(params as unknown as SendChatActionPayload);
        return {};
      }
      case 'answerCallbackQuery': {
        await api.raw.answerCallbackQuery(params as unknown as AnswerCallbackQueryPayload);
        return {};
      }
      default:
        // Unreachable: execute() gates on ALLOWED_JOB_METHODS before dispatching.
        throw new Error(`FlowCastle: unsupported job method '${job.method}'`);
    }
  }

  /** Long-poll GET /jobs. Throws on transport error (non-200, network, abort). */
  private async poll(): Promise<Job[]> {
    const controller = new AbortController();
    this.pollController = controller;
    const timeout = setTimeout(() => controller.abort(), POLL_CLIENT_TIMEOUT_MS);
    if (typeof timeout.unref === 'function') {
      timeout.unref();
    }
    try {
      const capabilities = [...ALLOWED_JOB_METHODS]
        .map((method) => `capability=${encodeURIComponent(`transport.telegram.bot_api.${method}`)}`)
        .join('&');
      const url = `${this.apiUrl}/api/sdk/v1/jobs?waitMs=${POLL_WAIT_MS}&max=${POLL_MAX}&protocolVersion=2&${capabilities}`;
      const response = await fetch(url, {
        method: 'GET',
        headers: { Authorization: `Bearer ${this.apiKey}` },
        signal: controller.signal,
      });
      if (!response.ok) {
        throw new Error(`FlowCastle: jobs poll failed (${response.status})`);
      }
      const body: unknown = await response.json();
      return parseJobs(body);
    } finally {
      clearTimeout(timeout);
      this.pollController = undefined;
    }
  }

  /** POST /jobs/ack. One retry on network error, then drop (server re-leases). */
  private async ack(results: AckResult[]): Promise<void> {
    if (results.length === 0) {
      return;
    }
    const url = `${this.apiUrl}/api/sdk/v1/jobs/ack`;
    let body: string;
    try {
      body = JSON.stringify({ protocolVersion: 2, results });
    } catch (error) {
      this.onError(error);
      return;
    }
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        const response = await fetch(url, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${this.apiKey}`,
            'Content-Type': 'application/json',
          },
          body,
        });
        if (!response.ok) throw new Error(`FlowCastle: jobs ack failed (${response.status})`);
        return;
      } catch (error) {
        if (attempt === 0) {
          continue;
        }
        this.onError(error);
        return;
      }
    }
  }

  /** Cancellable backoff wait; resolved early by {@link destroy}. */
  private delay(ms: number): Promise<void> {
    return new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        this.pendingDelay = undefined;
        resolve();
      }, ms);
      if (typeof timer.unref === 'function') {
        timer.unref();
      }
      this.pendingDelay = { timer, resolve };
    });
  }
}

function parseJobs(body: unknown): Job[] {
  if (!isObject(body) || !Array.isArray(body.jobs)) {
    return [];
  }
  const jobs: Job[] = [];
  for (const raw of body.jobs) {
    const operation = isObject(raw) && typeof raw.operation === 'string'
      ? raw.operation
      : isObject(raw) && typeof raw.method === 'string' ? raw.method : undefined;
    if (isObject(raw)
      && typeof raw.id === 'string'
      && typeof raw.leaseToken === 'string'
      && raw.leaseToken.length > 0
      && operation !== undefined) {
      jobs.push({
        id: raw.id,
        leaseToken: raw.leaseToken,
        method: operation,
        params: isObject(raw.params) ? raw.params : {},
      });
    }
  }
  return jobs;
}
