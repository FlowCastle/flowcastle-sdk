import { Bot, BotError, Context, GrammyError } from 'grammy';
import type { ApiClientOptions } from 'grammy';
import type { Update, UserFromGetMe } from 'grammy/types';

import type {
  SdkEvent,
  SdkGoalEvent,
  SdkIdentifyEvent,
  SdkLiveAgentRequestEvent,
  SdkOutgoingEvent,
  SdkUpdateEvent,
} from '../index';
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

/** A text message update on a chosen chat/user — for multi-chat window tests. */
function chatMessageUpdate(text: string, chatId: number, updateId = 1, fromId = 200): Update {
  return {
    update_id: updateId,
    message: {
      message_id: 10,
      date: 1,
      chat: { id: chatId, type: 'private', first_name: 'Chat' },
      from: { id: fromId, is_bot: false, first_name: 'Alice' },
      text,
    },
  };
}

/** A channel post — grammY exposes `ctx.chat` but no `ctx.from` for these. */
function channelPostUpdate(updateId = 1): Update {
  return {
    update_id: updateId,
    channel_post: {
      message_id: 10,
      date: 1,
      chat: { id: 100, type: 'channel', title: 'Chan' },
      text: 'hi',
    },
  };
}

function richMessageUpdate(): Update {
  return {
    update_id: 5,
    message: {
      message_id: 10,
      date: 1,
      chat: { id: 100, type: 'private', first_name: 'Chat' },
      from: { id: 200, is_bot: false, first_name: 'Alice' },
      text: 'secret text',
      entities: [{ type: 'bold', offset: 0, length: 6 }],
      caption: 'secret caption',
      caption_entities: [{ type: 'italic', offset: 0, length: 6 }],
    },
  };
}

/** Response the transport reads (only `.status` is inspected). */
function ingestOk(status = 202): Response {
  return new Response(null, { status });
}

/** A Telegram Bot API success/failure response for the injected client fetch. */
function telegramResponse(payload: unknown): Response {
  return new Response(JSON.stringify(payload), { status: 200, headers: { 'content-type': 'application/json' } });
}

/**
 * A `client.fetch` override that answers every Telegram Bot API call with a fixed
 * response. grammY's fetch type additionally carries node-fetch static members a
 * plain mock cannot provide, hence the widening cast (test-only).
 */
function telegramClientFetch(payload: unknown): NonNullable<ApiClientOptions['fetch']> {
  const fn = async (): Promise<Response> => telegramResponse(payload);
  return fn as unknown as NonNullable<ApiClientOptions['fetch']>;
}

interface Deferred<T = void> {
  promise: Promise<T>;
  resolve: (value: T) => void;
}

/** A manually-resolvable promise — lets tests order concurrent handlers deterministically. */
function deferred<T = void>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

const created: FlowCastleMiddleware<MyContext>[] = [];

function makePlugin(opts: Partial<FlowCastleOptions> = {}): FlowCastleMiddleware<MyContext> {
  const mw = flowcastle<MyContext>({
    apiKey: 'fc_sdk_test',
    apiUrl: API_URL,
    // These suites cover observation only; the pull channel has its own suite.
    pullJobs: false,
    ...opts,
  }) as FlowCastleMiddleware<MyContext>;
  created.push(mw);
  return mw;
}

function makeBot(clientFetch?: NonNullable<ApiClientOptions['fetch']>): Bot<MyContext> {
  const bot = clientFetch
    ? new Bot<MyContext>('42:TEST_TOKEN', { client: { fetch: clientFetch } })
    : new Bot<MyContext>('42:TEST_TOKEN');
  bot.botInfo = fakeBotInfo();
  return bot;
}

interface IngestCall {
  url: string;
  auth: string | undefined;
  batch: { sdkVersion: string; events: SdkEvent[] };
}

function ingestCalls(spy: jest.SpyInstance): IngestCall[] {
  return spy.mock.calls.map((call) => {
    const url = String(call[0]);
    const init = call[1] as RequestInit | undefined;
    const headers = (init?.headers ?? {}) as Record<string, string>;
    const body = typeof init?.body === 'string' ? init.body : '{}';
    return { url, auth: headers.Authorization, batch: JSON.parse(body) };
  });
}

function allEvents(spy: jest.SpyInstance): SdkEvent[] {
  return ingestCalls(spy).flatMap((call) => call.batch.events);
}

afterEach(() => {
  for (const mw of created) {
    mw.destroy();
  }
  created.length = 0;
  jest.restoreAllMocks();
  jest.useRealTimers();
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('flowcastle plugin — updates', () => {
  it('enqueues an update event and flushes it with the correct body and auth header', async () => {
    const fetchSpy = jest.spyOn(globalThis, 'fetch').mockResolvedValue(ingestOk());
    const bot = makeBot();
    const mw = makePlugin();
    bot.use(mw);

    await bot.handleUpdate(textMessageUpdate('hello world', 7));
    await mw.flush();

    const calls = ingestCalls(fetchSpy);
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe(`${API_URL}/api/sdk/v1/events`);
    expect(calls[0].auth).toBe('Bearer fc_sdk_test');
    expect(calls[0].batch.sdkVersion).toBe('0.4.0');

    const events = calls[0].batch.events;
    expect(events).toHaveLength(1);
    const update = events[0] as SdkUpdateEvent;
    expect(update.type).toBe('update');
    expect(typeof update.at).toBe('number');
    expect((update.update as Update).update_id).toBe(7);
  });
});

describe('flowcastle plugin — goal & identify', () => {
  it('enqueues goal and identify events with user/chat context and props', async () => {
    const fetchSpy = jest.spyOn(globalThis, 'fetch').mockResolvedValue(ingestOk());
    const bot = makeBot();
    const mw = makePlugin();
    bot.use(mw);
    bot.on('message', (ctx) => {
      ctx.flowcastle.goal('purchase', { value: 100 });
      ctx.flowcastle.identify({ plan: 'pro' });
    });

    await bot.handleUpdate(textMessageUpdate('buy'));
    await mw.flush();

    const events = allEvents(fetchSpy);
    const goal = events.find((e): e is SdkGoalEvent => e.type === 'goal');
    const identify = events.find((e): e is SdkIdentifyEvent => e.type === 'identify');

    expect(goal).toMatchObject({ key: 'purchase', telegramUserId: 200, chatId: 100, props: { value: 100 } });
    expect(identify).toMatchObject({ telegramUserId: 200, props: { plan: 'pro' } });
  });
});

describe('flowcastle plugin — transformer (outgoing calls)', () => {
  it('captures a successful outgoing Bot API call', async () => {
    const telegramFetch = telegramClientFetch({
      ok: true,
      result: { message_id: 7, date: 2, chat: { id: 100, type: 'private' }, text: 'hi there' },
    });
    const fetchSpy = jest.spyOn(globalThis, 'fetch').mockResolvedValue(ingestOk());

    const bot = makeBot(telegramFetch);
    const mw = makePlugin();
    bot.use(mw);
    bot.on('message', async (ctx) => {
      await ctx.reply('hi there');
    });

    await bot.handleUpdate(textMessageUpdate('ping'));
    await mw.flush();

    const outgoing = allEvents(fetchSpy).find((e): e is SdkOutgoingEvent => e.type === 'outgoing');
    expect(outgoing).toBeDefined();
    expect(outgoing).toMatchObject({
      method: 'sendMessage',
      ok: true,
      chatId: 100,
      result: { messageId: 7 },
    });
  });

  it('captures a failing outgoing call and still lets the host see the GrammyError', async () => {
    const telegramFetch = telegramClientFetch({
      ok: false,
      error_code: 403,
      description: 'Forbidden: bot was blocked by the user',
    });
    const fetchSpy = jest.spyOn(globalThis, 'fetch').mockResolvedValue(ingestOk());

    const bot = makeBot(telegramFetch);
    const mw = makePlugin();
    bot.use(mw);
    bot.on('message', async (ctx) => {
      await ctx.reply('hi');
    });

    // grammY surfaces the error through its normal error boundary (BotError),
    // with the original GrammyError untouched inside — proving observation-only.
    const thrown: unknown = await bot.handleUpdate(textMessageUpdate('ping')).catch((error: unknown) => error);
    expect(thrown).toBeInstanceOf(BotError);
    expect((thrown as BotError).error).toBeInstanceOf(GrammyError);
    await mw.flush();

    const outgoing = allEvents(fetchSpy).find((e): e is SdkOutgoingEvent => e.type === 'outgoing');
    expect(outgoing).toMatchObject({
      method: 'sendMessage',
      ok: false,
      errorCode: 403,
      errorDescription: 'Forbidden: bot was blocked by the user',
    });
  });
});

describe('flowcastle plugin — resilience', () => {
  it('never rejects handleUpdate when ingest fails; retries once then drops', async () => {
    const onError = jest.fn();
    const fetchSpy = jest.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('network down'));

    const bot = makeBot();
    const mw = makePlugin({ onError });
    bot.use(mw);

    await expect(bot.handleUpdate(textMessageUpdate('hi'))).resolves.toBeUndefined();
    await mw.flush();

    // One batch → initial attempt + one retry.
    expect(fetchSpy).toHaveBeenCalledTimes(2);
    expect(onError).toHaveBeenCalledWith(expect.any(Error));
  });

  it('propagates host handler exceptions (does not swallow next() errors)', async () => {
    const onError = jest.fn();
    const fetchSpy = jest.spyOn(globalThis, 'fetch').mockResolvedValue(ingestOk());

    const bot = makeBot();
    const mw = makePlugin({ onError });
    bot.use(mw);
    bot.on('message', () => {
      throw new Error('boom');
    });

    await expect(bot.handleUpdate(textMessageUpdate('hi'))).rejects.toThrow('boom');
    await mw.flush();

    // Update was still recorded before next() ran, and the host error was not routed to onError.
    const events = allEvents(fetchSpy);
    expect(events.some((e) => e.type === 'update')).toBe(true);
    expect(onError).not.toHaveBeenCalled();
  });
});

describe('flowcastle plugin — redaction', () => {
  it('strips text/caption/entities from buffered update events when redactText is on', async () => {
    const fetchSpy = jest.spyOn(globalThis, 'fetch').mockResolvedValue(ingestOk());
    const bot = makeBot();
    const mw = makePlugin({ redactText: true });
    bot.use(mw);

    await bot.handleUpdate(richMessageUpdate());
    await mw.flush();

    const update = allEvents(fetchSpy).find((e): e is SdkUpdateEvent => e.type === 'update');
    expect(update).toBeDefined();
    const message = ((update?.update ?? {}) as { message?: Record<string, unknown> }).message ?? {};
    expect(message.text).toBeUndefined();
    expect(message.caption).toBeUndefined();
    expect(message.entities).toBeUndefined();
    expect(message.caption_entities).toBeUndefined();
    // Non-text data is preserved.
    expect(message.message_id).toBe(10);
    expect((message.from as { id: number }).id).toBe(200);
  });

  it('applies contact allowlists and custom text transformation before buffering', async () => {
    const fetchSpy = jest.spyOn(globalThis, 'fetch').mockResolvedValue(ingestOk());
    const bot = makeBot();
    const mw = makePlugin({
      privacy: {
        contactFields: ['username'],
        messageContent: {
          mode: 'full',
          transformText: async ({ value }) => value.replace(/secret/g, '[REDACTED]'),
        },
      },
    });
    bot.use(mw);

    await bot.handleUpdate({
      ...textMessageUpdate('my secret'),
      message: {
        ...textMessageUpdate('my secret').message!,
        from: {
          id: 200,
          is_bot: false,
          first_name: 'Alice',
          last_name: 'Private',
          username: 'alice',
          language_code: 'en',
        },
      },
    });
    await mw.flush();

    const update = allEvents(fetchSpy).find((event): event is SdkUpdateEvent => event.type === 'update');
    const message = (update?.update as { message?: Record<string, unknown> } | undefined)?.message ?? {};
    const from = message.from as Record<string, unknown>;
    expect(message.text).toBe('my [REDACTED]');
    expect(from).toMatchObject({ id: 200, username: 'alice' });
    expect(from.first_name).toBeUndefined();
    expect(from.last_name).toBeUndefined();
    expect(from.language_code).toBeUndefined();
  });

  it('drops transformed content fail-closed without breaking the host handler', async () => {
    const onError = jest.fn();
    const fetchSpy = jest.spyOn(globalThis, 'fetch').mockResolvedValue(ingestOk());
    const bot = makeBot();
    const hostHandler = jest.fn();
    const mw = makePlugin({
      onError,
      privacy: {
        messageContent: {
          mode: 'full',
          transformText: () => {
            throw new Error('redactor failed');
          },
        },
      },
    });
    bot.use(mw);
    bot.on('message', hostHandler);

    await expect(bot.handleUpdate(textMessageUpdate('private text'))).resolves.toBeUndefined();
    await mw.flush();

    const update = allEvents(fetchSpy).find((event): event is SdkUpdateEvent => event.type === 'update');
    const message = (update?.update as { message?: Record<string, unknown> } | undefined)?.message ?? {};
    expect(message.text).toBeUndefined();
    expect(hostHandler).toHaveBeenCalledTimes(1);
    expect(onError).toHaveBeenCalledWith(expect.objectContaining({ message: expect.stringContaining('redactor failed') }));
  });

  it('applies the same text transformer to observed outgoing Bot API payloads', async () => {
    const telegramFetch = telegramClientFetch({ ok: true, result: { message_id: 7 } });
    const fetchSpy = jest.spyOn(globalThis, 'fetch').mockResolvedValue(ingestOk());
    const bot = makeBot(telegramFetch);
    const mw = makePlugin({
      privacy: {
        messageContent: {
          mode: 'full',
          transformText: ({ value }) => value.replace(/secret/g, '[REDACTED]'),
        },
      },
    });
    bot.use(mw);
    bot.on('message', async (ctx) => ctx.reply('outgoing secret'));

    await bot.handleUpdate(textMessageUpdate('incoming secret'));
    await mw.flush();

    const outgoing = allEvents(fetchSpy).find((event): event is SdkOutgoingEvent => event.type === 'outgoing');
    expect(outgoing?.payload).toMatchObject({ text: 'outgoing [REDACTED]' });
  });
});

describe('flowcastle plugin — correlation (Flow Map)', () => {
  it('stamps an outgoing call made inside a handler with the update_id', async () => {
    const telegramFetch = telegramClientFetch({ ok: true, result: { message_id: 7 } });
    const fetchSpy = jest.spyOn(globalThis, 'fetch').mockResolvedValue(ingestOk());

    const bot = makeBot(telegramFetch);
    const mw = makePlugin();
    bot.use(mw);
    bot.on('message', async (ctx) => {
      await ctx.reply('hi there');
    });

    await bot.handleUpdate(textMessageUpdate('ping', 77));
    await mw.flush();

    const outgoing = allEvents(fetchSpy).find((e): e is SdkOutgoingEvent => e.type === 'outgoing');
    expect(outgoing).toBeDefined();
    expect(outgoing?.correlationUpdateId).toBe(77);
  });

  it('keeps concurrent updates isolated — each outgoing call carries its own update_id', async () => {
    const telegramFetch = telegramClientFetch({ ok: true, result: { message_id: 7 } });
    const fetchSpy = jest.spyOn(globalThis, 'fetch').mockResolvedValue(ingestOk());

    const bot = makeBot(telegramFetch);
    const mw = makePlugin();
    bot.use(mw);

    const gates: Record<string, Deferred> = { a: deferred(), b: deferred() };
    bot.on('message', async (ctx) => {
      const key = ctx.message?.text ?? '';
      await gates[key].promise;
      await ctx.reply(`reply-${key}`);
    });

    // Fire both updates concurrently; neither handler proceeds until its gate opens.
    const p1 = bot.handleUpdate(textMessageUpdate('a', 11));
    const p2 = bot.handleUpdate(textMessageUpdate('b', 22));

    // Resolve out of order to prove correlation follows async context, not timing.
    gates.b.resolve();
    gates.a.resolve();
    await Promise.all([p1, p2]);
    await mw.flush();

    const outgoing = allEvents(fetchSpy).filter((e): e is SdkOutgoingEvent => e.type === 'outgoing');
    const byText = (text: string): SdkOutgoingEvent | undefined =>
      outgoing.find((e) => (e.payload as { text?: string } | undefined)?.text === text);

    expect(byText('reply-a')?.correlationUpdateId).toBe(11);
    expect(byText('reply-b')?.correlationUpdateId).toBe(22);
  });

  it('does not stamp an outgoing call made outside the update handling scope', async () => {
    const telegramFetch = telegramClientFetch({ ok: true, result: { message_id: 7 } });
    const fetchSpy = jest.spyOn(globalThis, 'fetch').mockResolvedValue(ingestOk());

    const bot = makeBot(telegramFetch);
    const mw = makePlugin();
    bot.use(mw);

    // Stash the context-scoped api (the one the transformer is installed on) and
    // call it AFTER the update has fully resolved — i.e. outside the correlation
    // AsyncLocalStorage scope, mimicking a setInterval-driven proactive send.
    let savedApi: Context['api'] | undefined;
    bot.on('message', (ctx) => {
      savedApi = ctx.api;
    });

    await bot.handleUpdate(textMessageUpdate('ping', 5));
    expect(savedApi).toBeDefined();
    await savedApi?.sendMessage(100, 'proactive');
    await mw.flush();

    const outgoing = allEvents(fetchSpy).filter((e): e is SdkOutgoingEvent => e.type === 'outgoing');
    const proactive = outgoing.find((e) => (e.payload as { text?: string } | undefined)?.text === 'proactive');
    expect(proactive).toBeDefined();
    expect(proactive?.correlationUpdateId).toBeUndefined();
  });

  it('stamps a goal fired inside a handler with the update_id', async () => {
    const fetchSpy = jest.spyOn(globalThis, 'fetch').mockResolvedValue(ingestOk());
    const bot = makeBot();
    const mw = makePlugin();
    bot.use(mw);
    bot.on('message', (ctx) => {
      ctx.flowcastle.goal('purchase', { value: 100 });
    });

    await bot.handleUpdate(textMessageUpdate('buy', 88));
    await mw.flush();

    const goal = allEvents(fetchSpy).find((e): e is SdkGoalEvent => e.type === 'goal');
    expect(goal?.correlationUpdateId).toBe(88);
  });
});

describe('flowcastle plugin — reply_markup sanitization', () => {
  it('keeps inline_keyboard buttons (text/callback_data/url) and drops richer button fields', async () => {
    const telegramFetch = telegramClientFetch({ ok: true, result: { message_id: 7 } });
    const fetchSpy = jest.spyOn(globalThis, 'fetch').mockResolvedValue(ingestOk());

    const bot = makeBot(telegramFetch);
    const mw = makePlugin();
    bot.use(mw);
    bot.on('message', async (ctx) => {
      await ctx.reply('menu', {
        reply_markup: {
          inline_keyboard: [
            [
              { text: 'Buy', callback_data: 'buy' },
              { text: 'Site', url: 'https://x.example' },
            ],
            [{ text: 'App', web_app: { url: 'https://app.example' } }],
          ],
        },
      });
    });

    await bot.handleUpdate(textMessageUpdate('open'));
    await mw.flush();

    const outgoing = allEvents(fetchSpy).find((e): e is SdkOutgoingEvent => e.type === 'outgoing');
    const keyboard = (outgoing?.payload as { reply_markup?: { inline_keyboard?: unknown[][] } } | undefined)?.reply_markup
      ?.inline_keyboard;
    expect(keyboard).toEqual([
      [
        { text: 'Buy', callback_data: 'buy' },
        { text: 'Site', url: 'https://x.example' },
      ],
      // web_app payload dropped; text preserved.
      [{ text: 'App' }],
    ]);
  });

  it('drops non-inline reply_markup kinds (reply keyboard, force_reply)', async () => {
    const telegramFetch = telegramClientFetch({ ok: true, result: { message_id: 7 } });
    const fetchSpy = jest.spyOn(globalThis, 'fetch').mockResolvedValue(ingestOk());

    const bot = makeBot(telegramFetch);
    const mw = makePlugin();
    bot.use(mw);
    bot.on('message', async (ctx) => {
      await ctx.reply('pick', { reply_markup: { keyboard: [[{ text: 'k' }]] } });
      await ctx.reply('answer', { reply_markup: { force_reply: true } });
    });

    await bot.handleUpdate(textMessageUpdate('open'));
    await mw.flush();

    const outgoing = allEvents(fetchSpy).filter((e): e is SdkOutgoingEvent => e.type === 'outgoing');
    for (const event of outgoing) {
      expect((event.payload as { reply_markup?: unknown } | undefined)?.reply_markup).toBeUndefined();
    }
  });

  it('replaces button text with a marker under redactText but keeps callback_data', async () => {
    const telegramFetch = telegramClientFetch({ ok: true, result: { message_id: 7 } });
    const fetchSpy = jest.spyOn(globalThis, 'fetch').mockResolvedValue(ingestOk());

    const bot = makeBot(telegramFetch);
    const mw = makePlugin({ redactText: true });
    bot.use(mw);
    bot.on('message', async (ctx) => {
      await ctx.reply('menu', {
        reply_markup: { inline_keyboard: [[{ text: 'Buy now', callback_data: 'buy' }]] },
      });
    });

    await bot.handleUpdate(textMessageUpdate('open'));
    await mw.flush();

    const outgoing = allEvents(fetchSpy).find((e): e is SdkOutgoingEvent => e.type === 'outgoing');
    const keyboard = (outgoing?.payload as { reply_markup?: { inline_keyboard?: unknown[][] } } | undefined)?.reply_markup
      ?.inline_keyboard;
    expect(keyboard).toEqual([[{ text: '[redacted]', callback_data: 'buy' }]]);
  });
});

describe('flowcastle plugin — live agent escalation', () => {
  it('requestLiveAgent enqueues a live_agent_request event flushed to ingest', async () => {
    const fetchSpy = jest.spyOn(globalThis, 'fetch').mockResolvedValue(ingestOk());
    const bot = makeBot();
    const mw = makePlugin();
    bot.use(mw);
    bot.on('message', (ctx) => {
      ctx.flowcastle.requestLiveAgent({ note: 'User asked for a human' });
    });

    await bot.handleUpdate(textMessageUpdate('support', 9));
    await mw.flush();

    const event = allEvents(fetchSpy).find((e): e is SdkLiveAgentRequestEvent => e.type === 'live_agent_request');
    expect(event).toMatchObject({
      type: 'live_agent_request',
      telegramUserId: 200,
      chatId: 100,
      note: 'User asked for a human',
    });
  });

  it('clamps the note to 500 chars', async () => {
    const fetchSpy = jest.spyOn(globalThis, 'fetch').mockResolvedValue(ingestOk());
    const bot = makeBot();
    const mw = makePlugin();
    bot.use(mw);
    bot.on('message', (ctx) => {
      ctx.flowcastle.requestLiveAgent({ note: 'x'.repeat(600) });
    });

    await bot.handleUpdate(textMessageUpdate('support', 9));
    await mw.flush();

    const event = allEvents(fetchSpy).find((e): e is SdkLiveAgentRequestEvent => e.type === 'live_agent_request');
    expect(event?.note).toHaveLength(500);
  });

  it('isLiveAgentActive is true for the same chat after requestLiveAgent, false for a different chat', async () => {
    jest.spyOn(globalThis, 'fetch').mockResolvedValue(ingestOk());
    const bot = makeBot();
    const mw = makePlugin();
    bot.use(mw);

    const active: Record<number, boolean> = {};
    bot.on('message', (ctx) => {
      if (ctx.message?.text === 'escalate') {
        ctx.flowcastle.requestLiveAgent();
      }
      const chatId = ctx.chat?.id;
      if (chatId !== undefined) {
        active[chatId] = ctx.flowcastle.isLiveAgentActive;
      }
    });

    // Escalate on chat 100, then read the flag on a later update for the same chat…
    await bot.handleUpdate(chatMessageUpdate('escalate', 100, 1));
    await bot.handleUpdate(chatMessageUpdate('check', 100, 2));
    // …and on a different chat, which must be unaffected.
    await bot.handleUpdate(chatMessageUpdate('check', 999, 3, 201));

    expect(active[100]).toBe(true);
    expect(active[999]).toBe(false);
  });

  it('isLiveAgentActive returns false once the window expires', async () => {
    jest.useFakeTimers();
    jest.spyOn(globalThis, 'fetch').mockResolvedValue(ingestOk());
    const bot = makeBot();
    const mw = makePlugin({ liveAgentWindowMs: 1000 });
    bot.use(mw);

    const readings: boolean[] = [];
    bot.on('message', (ctx) => {
      if (ctx.message?.text === 'escalate') {
        ctx.flowcastle.requestLiveAgent();
      }
      readings.push(ctx.flowcastle.isLiveAgentActive);
    });

    await bot.handleUpdate(chatMessageUpdate('escalate', 100, 1)); // opens window
    await bot.handleUpdate(chatMessageUpdate('check', 100, 2)); // within window → true
    await jest.advanceTimersByTimeAsync(1001); // past liveAgentWindowMs
    await bot.handleUpdate(chatMessageUpdate('check', 100, 3)); // expired → false

    expect(readings).toEqual([true, true, false]);
  });

  it('requestLiveAgent without ctx.from calls onError and enqueues nothing', async () => {
    const onError = jest.fn();
    const fetchSpy = jest.spyOn(globalThis, 'fetch').mockResolvedValue(ingestOk());
    const bot = makeBot();
    const mw = makePlugin({ onError });
    bot.use(mw);
    bot.on('channel_post', (ctx) => {
      ctx.flowcastle.requestLiveAgent({ note: 'no from here' });
    });

    await bot.handleUpdate(channelPostUpdate(9));
    await mw.flush();

    expect(onError).toHaveBeenCalledWith(expect.any(Error));
    const event = allEvents(fetchSpy).find((e): e is SdkLiveAgentRequestEvent => e.type === 'live_agent_request');
    expect(event).toBeUndefined();
  });
});
