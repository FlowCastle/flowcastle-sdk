import { Bot, Context } from 'grammy';
import type { ApiClientOptions } from 'grammy';
import type { Update, UserFromGetMe } from 'grammy/types';

import type { SdkEvent, SdkOutgoingEvent } from '../index';
import { flowcastle, FlowCastleFlavor, FlowCastleMiddleware, FlowCastleOptions } from '../index';

type MyContext = FlowCastleFlavor<Context>;

const API_URL = 'https://ingest.test';

// ---------------------------------------------------------------------------
// Fixtures & helpers
// ---------------------------------------------------------------------------

function fakeBotInfo(): UserFromGetMe {
  return {
    id: 42,
    is_bot: true,
    first_name: 'Test',
    username: 'test_bot',
    can_join_groups: true,
    can_read_all_group_messages: false,
    can_manage_bots: false,
    supports_inline_queries: false,
    can_connect_to_business: false,
    has_main_web_app: false,
    has_topics_enabled: false,
    allows_users_to_create_topics: false,
    supports_join_request_queries: false,
  };
}

function textMessageUpdate(text: string, updateId = 1): Update {
  return {
    update_id: updateId,
    message: {
      message_id: 10,
      date: 1,
      chat: { id: 100, type: 'private', first_name: 'Chat' },
      from: { id: 200, is_bot: false, first_name: 'Alice' },
      text,
    },
  };
}

interface Deferred<T = void> {
  promise: Promise<T>;
  resolve: (value: T) => void;
}

function deferred<T = void>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

/** A `client.fetch` override recording every Telegram Bot API call by method. */
interface TelegramClient {
  fetch: NonNullable<ApiClientOptions['fetch']>;
  methods: string[];
}

/**
 * Answers Telegram Bot API calls. `respond(method)` returns the JSON body for a
 * given method (the URL path ends with `/<method>`). Records each method seen.
 */
function telegramClient(respond: (method: string) => unknown): TelegramClient {
  const methods: string[] = [];
  const fn = async (input: unknown): Promise<Response> => {
    const url = String(input);
    const method = url.slice(url.lastIndexOf('/') + 1);
    methods.push(method);
    const payload = respond(method);
    return new Response(JSON.stringify(payload), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  };
  return { fetch: fn as unknown as NonNullable<ApiClientOptions['fetch']>, methods };
}

interface Job {
  id: string;
  leaseToken?: string;
  operation?: string;
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

/** One scripted answer for a GET /jobs long-poll. */
type PollScript = { kind: 'jobs'; jobs: Job[] } | { kind: 'error' };

/**
 * A fake FlowCastle pull server driven through the global `fetch` spy. Routes by
 * URL: GET /jobs (long-poll), POST /jobs/ack, POST /events (ingest). GET /jobs
 * answers scripted responses in order; once the script is exhausted it PARKS
 * (returns a promise that only rejects when the request's AbortSignal fires),
 * halting the loop so tests stay deterministic and destroy() can abort cleanly.
 */
interface ThresholdWaiter {
  target: number;
  resolve: () => void;
}

class JobServer {
  readonly fetch: jest.Mock;
  readonly ackBodies: AckResult[][] = [];
  readonly ingestEvents: SdkEvent[] = [];
  private readonly pollScript: PollScript[];
  private pollIndex = 0;
  private pollCount = 0;
  private ackCount = 0;
  private readonly pollWaiters: ThresholdWaiter[] = [];
  private readonly ackWaiters: ThresholdWaiter[] = [];
  private readonly ackStatuses: number[];

  constructor(pollScript: PollScript[], ackStatuses: number[] = []) {
    this.pollScript = pollScript;
    this.ackStatuses = ackStatuses;
    this.fetch = jest.fn((input: unknown, init?: RequestInit): Promise<Response> => {
      const url = String(input);
      if (url.includes('/api/sdk/v1/jobs/ack')) {
        return this.handleAck(init);
      }
      if (url.includes('/api/sdk/v1/jobs')) {
        return this.handlePoll(init);
      }
      // Ingest endpoint — accept and record.
      if (url.includes('/api/sdk/v1/events')) {
        const body = typeof init?.body === 'string' ? init.body : '{}';
        const batch = JSON.parse(body) as { events?: SdkEvent[] };
        for (const event of batch.events ?? []) {
          this.ingestEvents.push(event);
        }
      }
      return Promise.resolve(new Response(null, { status: 202 }));
    });
  }

  /** Number of GET /jobs calls seen so far. */
  get pollCalls(): number {
    return this.pollCount;
  }

  /** Resolves once at least `n` GET /jobs calls have been made. */
  waitForPoll(n: number): Promise<void> {
    return this.threshold(n, this.pollCount, this.pollWaiters);
  }

  /** Resolves once at least `n` POST /jobs/ack calls have completed. */
  waitForAck(n: number): Promise<void> {
    return this.threshold(n, this.ackCount, this.ackWaiters);
  }

  private threshold(target: number, current: number, pool: ThresholdWaiter[]): Promise<void> {
    if (current >= target) {
      return Promise.resolve();
    }
    const d = deferred();
    pool.push({ target, resolve: d.resolve });
    return d.promise;
  }

  private release(pool: ThresholdWaiter[], count: number): void {
    for (let i = pool.length - 1; i >= 0; i -= 1) {
      if (count >= pool[i].target) {
        pool[i].resolve();
        pool.splice(i, 1);
      }
    }
  }

  private handlePoll(init?: RequestInit): Promise<Response> {
    this.pollCount += 1;
    this.release(this.pollWaiters, this.pollCount);
    const script = this.pollScript[this.pollIndex];
    if (script !== undefined) {
      this.pollIndex += 1;
      if (script.kind === 'error') {
        return Promise.reject(new Error('network down'));
      }
      return Promise.resolve(
        new Response(JSON.stringify({ jobs: script.jobs }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      );
    }
    // Script exhausted — park until aborted.
    return this.park(init?.signal);
  }

  private park(signal?: AbortSignal | null): Promise<Response> {
    return new Promise<Response>((_resolve, reject) => {
      if (signal == null) {
        return;
      }
      if (signal.aborted) {
        reject(new DOMException('Aborted', 'AbortError'));
        return;
      }
      signal.addEventListener('abort', () => {
        reject(new DOMException('Aborted', 'AbortError'));
      });
    });
  }

  private async handleAck(init?: RequestInit): Promise<Response> {
    const body = typeof init?.body === 'string' ? init.body : '{}';
    const parsed = JSON.parse(body) as { results: AckResult[] };
    this.ackBodies.push(parsed.results);
    this.ackCount += 1;
    this.release(this.ackWaiters, this.ackCount);
    return new Response(null, { status: this.ackStatuses.shift() ?? 200 });
  }
}

const created: FlowCastleMiddleware<MyContext>[] = [];

function makePlugin(opts: Partial<FlowCastleOptions> = {}): FlowCastleMiddleware<MyContext> {
  const mw = flowcastle<MyContext>({
    apiKey: 'fc_sdk_test',
    apiUrl: API_URL,
    flushIntervalMs: 1_000_000,
    ...opts,
  }) as FlowCastleMiddleware<MyContext>;
  created.push(mw);
  return mw;
}

function makeBot(client: TelegramClient): Bot<MyContext> {
  const bot = new Bot<MyContext>('42:TEST_TOKEN', { client: { fetch: client.fetch } });
  bot.botInfo = fakeBotInfo();
  return bot;
}

afterEach(() => {
  for (const mw of created) {
    mw.destroy();
  }
  created.length = 0;
  jest.restoreAllMocks();
  jest.useRealTimers();
});

const outgoingEvents = (events: SdkEvent[]): SdkOutgoingEvent[] =>
  events.filter((e): e is SdkOutgoingEvent => e.type === 'outgoing');

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('JobPuller — lifecycle', () => {
  it('idles until an update arrives (no /jobs poll before setApi)', async () => {
    const server = new JobServer([]);
    jest.spyOn(globalThis, 'fetch').mockImplementation(server.fetch);
    const client = telegramClient(() => ({ ok: true, result: { message_id: 1 } }));

    makeBot(client);
    const mw = makePlugin();

    // No update handled yet → the puller never received an Api → never polls.
    await new Promise((r) => setImmediate(r));
    expect(server.pollCalls).toBe(0);
  });

  it('polls /jobs after the first update supplies the Api', async () => {
    const server = new JobServer([]); // exhausted → parks after first poll
    jest.spyOn(globalThis, 'fetch').mockImplementation(server.fetch);
    const client = telegramClient(() => ({ ok: true, result: { message_id: 1 } }));

    const bot = makeBot(client);
    const mw = makePlugin();
    bot.use(mw);

    await bot.handleUpdate(textMessageUpdate('hi'));
    await server.waitForPoll(1);

    expect(server.pollCalls).toBeGreaterThanOrEqual(1);
    const call = server.fetch.mock.calls.find((c) => String(c[0]).includes('/api/sdk/v1/jobs'));
    expect(call).toBeDefined();
    expect(String(call?.[0])).toContain('waitMs=25000');
    expect(String(call?.[0])).toContain('max=10');
    expect(String(call?.[0])).toContain('protocolVersion=2');
    expect(String(call?.[0])).toContain('capability=transport.telegram.bot_api.sendMessage');
    const headers = ((call?.[1] as RequestInit | undefined)?.headers ?? {}) as Record<string, string>;
    expect(headers.Authorization).toBe('Bearer fc_sdk_test');
  });
});

describe('JobPuller — execution & ack', () => {
  it('ignores a protocol-v2 job without a lease token before any Telegram side effect', async () => {
    const server = new JobServer([
      { kind: 'jobs', jobs: [{ id: 'unleased', method: 'sendMessage', params: { chat_id: 100, text: 'must not send' } }] },
    ]);
    jest.spyOn(globalThis, 'fetch').mockImplementation(server.fetch);
    const client = telegramClient(() => ({ ok: true, result: { message_id: 555 } }));
    const bot = makeBot(client);
    const mw = makePlugin();
    bot.use(mw);

    await bot.handleUpdate(textMessageUpdate('hi'));
    await server.waitForPoll(2);

    expect(client.methods).not.toContain('sendMessage');
    expect(server.ackBodies).toEqual([]);
  });

  it('executes a sendMessage job and acks ok:true with the messageId', async () => {
    const server = new JobServer([
      { kind: 'jobs', jobs: [{ id: 'job-1', leaseToken: 'lease-1', method: 'sendMessage', params: { chat_id: 100, text: 'agent reply' } }] },
    ]);
    jest.spyOn(globalThis, 'fetch').mockImplementation(server.fetch);
    const client = telegramClient(() => ({ ok: true, result: { message_id: 555 } }));

    const bot = makeBot(client);
    const mw = makePlugin();
    bot.use(mw);

    await bot.handleUpdate(textMessageUpdate('hi'));
    await server.waitForAck(1);

    // Executed through the host bot's Telegram connection.
    expect(client.methods).toContain('sendMessage');
    // Acked as success with the returned message id.
    expect(server.ackBodies[0]).toEqual([{ id: 'job-1', leaseToken: 'lease-1', ok: true, result: { messageId: 555 } }]);
  });

  it('retries an ack when the server returns a non-success HTTP status', async () => {
    const server = new JobServer([
      { kind: 'jobs', jobs: [{ id: 'job-retry', leaseToken: 'lease-retry', method: 'sendMessage', params: { chat_id: 100, text: 'once' } }] },
    ], [500, 200]);
    jest.spyOn(globalThis, 'fetch').mockImplementation(server.fetch);
    const client = telegramClient(() => ({ ok: true, result: { message_id: 556 } }));
    const bot = makeBot(client);
    const mw = makePlugin();
    bot.use(mw);

    await bot.handleUpdate(textMessageUpdate('hi'));
    await server.waitForAck(2);

    expect(client.methods.filter((method) => method === 'sendMessage')).toHaveLength(1);
    expect(server.ackBodies).toHaveLength(2);
  });

  it('refuses a non-allowlisted method: acks ok:false 400 and never executes it', async () => {
    const server = new JobServer([
      { kind: 'jobs', jobs: [{ id: 'job-x', leaseToken: 'lease-x', method: 'deleteMessage', params: { chat_id: 100, message_id: 5 } }] },
    ]);
    jest.spyOn(globalThis, 'fetch').mockImplementation(server.fetch);
    const client = telegramClient(() => ({ ok: true, result: true }));
    const onError = jest.fn();

    const bot = makeBot(client);
    const mw = makePlugin({ onError });
    bot.use(mw);

    await bot.handleUpdate(textMessageUpdate('hi'));
    await server.waitForAck(1);

    expect(server.ackBodies[0]).toEqual([
      { id: 'job-x', leaseToken: 'lease-x', ok: false, error: { code: 400, description: 'method not allowed' }, errorCode: 400, errorDescription: 'method not allowed' },
    ]);
    // The disallowed method never touched the Telegram connection.
    expect(client.methods).not.toContain('deleteMessage');
    expect(onError).toHaveBeenCalledWith(expect.any(Error));
    // Loop survived and keeps polling.
    await server.waitForPoll(2);
    expect(server.pollCalls).toBeGreaterThanOrEqual(2);
  });

  it('acks ok:false with the error_code when an allowed job hits a 403 GrammyError, and survives', async () => {
    const server = new JobServer([
      { kind: 'jobs', jobs: [{ id: 'job-403', leaseToken: 'lease-403', method: 'sendMessage', params: { chat_id: 100, text: 'blocked?' } }] },
    ]);
    jest.spyOn(globalThis, 'fetch').mockImplementation(server.fetch);
    const client = telegramClient(() => ({
      ok: false,
      error_code: 403,
      description: 'Forbidden: bot was blocked by the user',
    }));

    const bot = makeBot(client);
    const mw = makePlugin();
    bot.use(mw);

    await bot.handleUpdate(textMessageUpdate('hi'));
    await server.waitForAck(1);

    expect(server.ackBodies[0]).toEqual([
      { id: 'job-403', leaseToken: 'lease-403', ok: false, error: { code: 403, description: 'Forbidden: bot was blocked by the user' }, errorCode: 403, errorDescription: 'Forbidden: bot was blocked by the user' },
    ]);
    // Loop survived the failed job.
    await server.waitForPoll(2);
    expect(server.pollCalls).toBeGreaterThanOrEqual(2);
  });
});

describe('JobPuller — transformer observation & echo-loop guard', () => {
  it('surfaces a job-executed send as an outgoing event stamped with correlationJobId', async () => {
    const server = new JobServer([
      { kind: 'jobs', jobs: [{ id: 'job-echo', leaseToken: 'lease-echo', method: 'sendMessage', params: { chat_id: 100, text: 'agent reply' } }] },
    ]);
    jest.spyOn(globalThis, 'fetch').mockImplementation(server.fetch);
    const client = telegramClient(() => ({ ok: true, result: { message_id: 7 } }));

    const bot = makeBot(client);
    const mw = makePlugin();
    bot.use(mw);
    // A normal handler send, to contrast with the job-executed send.
    bot.on('message', async (ctx) => {
      await ctx.reply('handler reply');
    });

    await bot.handleUpdate(textMessageUpdate('ping', 99));
    await server.waitForAck(1);
    await mw.flush();

    const outgoing = outgoingEvents(server.ingestEvents);
    const jobSend = outgoing.find((e) => (e.payload as { text?: string } | undefined)?.text === 'agent reply');
    const handlerSend = outgoing.find((e) => (e.payload as { text?: string } | undefined)?.text === 'handler reply');

    expect(jobSend).toBeDefined();
    expect(jobSend?.correlationJobId).toBe('job-echo');

    // The bot's own send carries no job id (and no cross-contamination).
    expect(handlerSend).toBeDefined();
    expect(handlerSend?.correlationJobId).toBeUndefined();
  });
});

describe('JobPuller — live-agent window refresh', () => {
  it('a delivered agent-reply job opens the live-agent window for its chat', async () => {
    const server = new JobServer([
      { kind: 'jobs', jobs: [{ id: 'job-1', leaseToken: 'lease-1', method: 'sendMessage', params: { chat_id: 100, text: 'agent reply' } }] },
    ]);
    jest.spyOn(globalThis, 'fetch').mockImplementation(server.fetch);
    const client = telegramClient(() => ({ ok: true, result: { message_id: 5 } }));

    const bot = makeBot(client);
    const mw = makePlugin();
    bot.use(mw);

    let active: boolean | undefined;
    bot.on('message', (ctx) => {
      active = ctx.flowcastle.isLiveAgentActive;
    });

    // First update starts the puller (and its chat is 100).
    await bot.handleUpdate(textMessageUpdate('hi'));
    // Wait for the agent-reply job to be executed & acked → window touched for 100.
    await server.waitForAck(1);
    // A later update on chat 100 now sees the live-agent window open.
    await bot.handleUpdate(textMessageUpdate('again', 2));

    expect(active).toBe(true);
  });
});

describe('JobPuller — resilience', () => {
  it('backs off on a /jobs transport error and the loop survives', async () => {
    const onError = jest.fn();
    const server = new JobServer([{ kind: 'error' }]); // 1st poll rejects, then parks
    jest.spyOn(globalThis, 'fetch').mockImplementation(server.fetch);
    const client = telegramClient(() => ({ ok: true, result: { message_id: 1 } }));

    jest.useFakeTimers();
    const bot = makeBot(client);
    const mw = makePlugin({ onError });
    bot.use(mw);

    await bot.handleUpdate(textMessageUpdate('hi'));
    // First poll rejects → onError + a 1s backoff timer scheduled.
    await server.waitForPoll(1);

    // Advance past the backoff; the loop must poll again (survived the error).
    await jest.advanceTimersByTimeAsync(1000);
    await server.waitForPoll(2);

    expect(onError).toHaveBeenCalledWith(expect.any(Error));
    expect(server.pollCalls).toBeGreaterThanOrEqual(2);
  });

  it('destroy() aborts the in-flight long-poll and stops polling with no further fetch', async () => {
    const server = new JobServer([]); // parks on the first poll
    jest.spyOn(globalThis, 'fetch').mockImplementation(server.fetch);
    const client = telegramClient(() => ({ ok: true, result: { message_id: 1 } }));

    const bot = makeBot(client);
    const mw = makePlugin();
    bot.use(mw);

    await bot.handleUpdate(textMessageUpdate('hi'));
    await server.waitForPoll(1);
    const pollsBefore = server.pollCalls;

    // Aborts the parked long-poll and stops the loop — must not throw/reject.
    expect(() => mw.destroy()).not.toThrow();
    // Give any (incorrect) continuation a chance to fire another poll.
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));

    expect(server.pollCalls).toBe(pollsBefore);
  });
});
