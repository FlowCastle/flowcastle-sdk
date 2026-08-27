import { AsyncLocalStorage } from 'node:async_hooks';

import { Telegraf } from 'telegraf';
import type { Context, Telegram } from 'telegraf';
import type { Update, UserFromGetMe } from 'telegraf/types';

import { flowcastle } from '../index';
import type { FlowCastleCtx, FlowCastleFlavor, FlowCastleMiddleware, FlowCastleOptions } from '../index';
import { JobPuller } from '../jobs';
import { TelegrafRuntimeJobExecutor } from '../runtime';
import { ConversationClaims } from '@flowcastle/sdk-runtime';
import type { RuntimeJob } from '@flowcastle/sdk-runtime';

const API_URL = 'https://flowcastle.test';

type TestContext = FlowCastleFlavor<Context>;

interface FetchRecord {
  url: string;
  init: RequestInit | undefined;
}

interface FakeTelegram {
  callApi: (...args: unknown[]) => Promise<unknown>;
  getMe: () => Promise<{ id: number; username: string }>;
}

function response(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

function update(text: string, updateId = 1): Record<string, unknown> {
  return {
    update_id: updateId,
    message: {
      message_id: 10,
      date: 1,
      chat: { id: 100, type: 'private', first_name: 'Private chat' },
      from: { id: 200, is_bot: false, first_name: 'Alice', username: 'alice' },
      text,
    },
  };
}

function botInfo(): UserFromGetMe {
  return {
    id: 42,
    is_bot: true,
    first_name: 'FlowCastle Test',
    username: 'test_bot',
    can_join_groups: true,
    can_read_all_group_messages: false,
    supports_inline_queries: false,
  };
}

function makeTelegram(result: unknown = { message_id: 7 }): FakeTelegram {
  return {
    callApi: jest.fn(async (): Promise<unknown> => result),
    getMe: jest.fn(async () => ({ id: 42, username: 'test_bot' })),
  };
}

function makeContext(rawUpdate: Record<string, unknown>, telegram: FakeTelegram): TestContext {
  const message = rawUpdate.message as { chat: { id: number }; from: { id: number } };
  return {
    update: rawUpdate,
    telegram: telegram as unknown as Telegram,
    from: message.from,
    chat: message.chat,
    botInfo: { id: 42, username: 'test_bot' },
  } as unknown as TestContext;
}

function events(records: FetchRecord[]): unknown[] {
  return records
    .filter((record) => record.url.endsWith('/api/sdk/v1/events'))
    .flatMap((record) => {
      const body = typeof record.init?.body === 'string' ? JSON.parse(record.init.body) as { events: unknown[] } : { events: [] };
      return body.events;
    });
}

function plugin(options: Partial<FlowCastleOptions> = {}): FlowCastleMiddleware<TestContext> {
  return flowcastle<TestContext>({
    apiKey: 'fc_sdk_test',
    apiUrl: API_URL,
    pullJobs: false,
    flushIntervalMs: 60_000,
    ...options,
  });
}

afterEach(() => {
  jest.restoreAllMocks();
});

describe('FlowCastle Telegraf middleware', () => {
  it('routes through the real Telegraf dispatcher without a Telegram token call', async () => {
    // Arrange
    jest.spyOn(globalThis, 'fetch').mockImplementation(async (input, init): Promise<Response> => {
      const url = String(input);
      if (url.endsWith('/manifest')) return response({
        protocolVersion: 2,
        version: 'dispatcher-v1',
        rules: [{ id: 'start', flowId: 'welcome', kind: 'command', command: 'start' }],
      });
      if (url.endsWith('/claims')) return response({ cursor: 'c1', claims: [] });
      if (url.includes('/jobs')) {
        return new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
        });
      }
      return response({}, 202);
    });
    const bot = new Telegraf<TestContext>('42:TEST');
    bot.botInfo = botInfo();
    Object.defineProperty(bot.telegram, 'callApi', {
      configurable: true,
      writable: true,
      value: jest.fn(async (method: string): Promise<unknown> => method === 'getMe' ? botInfo() : true),
    });
    const middleware = plugin({ runtime: { enabled: true } });
    const customerHandler = jest.fn(async (): Promise<void> => undefined);
    middleware.wrapTelegram(bot.telegram);
    bot.use(middleware);
    bot.on('text', customerHandler);
    await middleware.ready();

    // Act
    await bot.handleUpdate(update('/start', 10) as unknown as Update);
    await bot.handleUpdate(update('/help', 11) as unknown as Update);

    // Assert
    expect(customerHandler).toHaveBeenCalledTimes(1);
    middleware.destroy();
  });

  it('consumes a manifest-matched update while an unmatched update continues to downstream middleware', async () => {
    // Arrange
    const records: FetchRecord[] = [];
    jest.spyOn(globalThis, 'fetch').mockImplementation(async (input, init): Promise<Response> => {
      const url = String(input);
      records.push({ url, init });
      if (url.endsWith('/manifest')) return response({ protocolVersion: 2, version: 'v1', rules: [{ id: 'start', flowId: 'welcome', kind: 'command', command: 'start' }] });
      if (url.endsWith('/claims')) return response({ cursor: 'c1', claims: [] });
      if (url.includes('/jobs')) return new Promise<Response>((_resolve, reject) => init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError'))));
      return response({}, 202);
    });
    const middleware = plugin({ runtime: { enabled: true } });
    await middleware.ready();
    const matchedNext = jest.fn(async (): Promise<void> => undefined);
    const unmatchedNext = jest.fn(async (): Promise<void> => undefined);

    // Act
    await middleware(makeContext(update('/start'), makeTelegram()), matchedNext);
    await middleware(makeContext(update('/help'), makeTelegram()), unmatchedNext);
    await middleware.flush();

    // Assert
    expect(matchedNext).not.toHaveBeenCalled();
    expect(unmatchedNext).toHaveBeenCalledTimes(1);
    expect(events(records)).toEqual(expect.arrayContaining([expect.objectContaining({ type: 'update', handled: true })]));
    expect(JSON.stringify(events(records)).match(/"text":"\/start"/g)).toHaveLength(1);
    middleware.destroy();
  });

  it('filters outgoing content locally before it enters the event buffer', async () => {
    // Arrange
    const records: FetchRecord[] = [];
    jest.spyOn(globalThis, 'fetch').mockImplementation(async (input, init): Promise<Response> => {
      records.push({ url: String(input), init });
      return response({}, 202);
    });
    const middleware = plugin({ privacy: { contactFields: [], messageContent: 'routing' } });
    const telegram = makeTelegram({ message_id: 44 });
    middleware.wrapTelegram(telegram as unknown as Telegram);

    // Act
    await telegram.callApi('sendMessage', { chat_id: 100, text: 'private outgoing message' });
    await middleware.flush();

    // Assert
    const captured = JSON.stringify(events(records));
    expect(captured).toContain('sendMessage');
    expect(captured).not.toContain('private outgoing message');
    middleware.destroy();
  });

  it('exposes goal and runtime runFlow to downstream handlers with the sanitized update', async () => {
    // Arrange
    const requests: FetchRecord[] = [];
    jest.spyOn(globalThis, 'fetch').mockImplementation(async (input, init): Promise<Response> => {
      const url = String(input);
      requests.push({ url, init });
      if (url.includes('/runtime-runs')) return response({ executionId: 'run-1' }, 202);
      if (url.includes('/jobs')) return new Promise<Response>((_resolve, reject) => init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError'))));
      return response({}, 202);
    });
    const middleware = plugin({ runtime: { enabled: true }, privacy: { contactFields: [], messageContent: 'routing' } });
    const context = makeContext(update('/help referral-secret'), makeTelegram());
    let flowcastleContext: FlowCastleCtx | undefined;

    // Act
    await middleware(context, async (): Promise<void> => {
      flowcastleContext = context.flowcastle;
      context.flowcastle.goal('signup', { plan: 'pro' });
      await context.flowcastle.runFlow('manual', { inputs: { source: 'test' } });
    });
    await middleware.flush();

    // Assert
    expect(flowcastleContext).toBeDefined();
    expect(events(requests)).toEqual(expect.arrayContaining([expect.objectContaining({ type: 'goal', key: 'signup', telegramUserId: 200, chatId: 100 })]));
    const runRequest = requests.find((request) => request.url.includes('/runtime-runs'));
    expect(String(runRequest?.init?.body)).toContain('"flowKey":"manual"');
    expect(String(runRequest?.init?.body)).not.toContain('referral-secret');
    middleware.destroy();
  });
});

describe('Telegraf proxy job executor', () => {
  it('executes an allowlisted outgoing job and refuses a lifecycle method', async () => {
    // Arrange
    const telegram = makeTelegram({ message_id: 91 });
    const onError = jest.fn();
    const executor = new TelegrafRuntimeJobExecutor(
      telegram as unknown as Telegram,
      new ConversationClaims(),
      new AsyncLocalStorage<string>(),
      onError,
    );
    const allowed: RuntimeJob = {
      protocolVersion: 2,
      id: 'send-1',
      leaseToken: 'lease-1',
      kind: 'telegram_call',
      method: 'sendMessage',
      params: { chat_id: 100, text: 'agent reply' },
    };
    const denied: RuntimeJob = {
      protocolVersion: 2,
      id: 'webhook-1',
      leaseToken: 'lease-2',
      kind: 'telegram_call',
      method: 'setWebhook',
      params: { url: 'https://attacker.invalid' },
    };

    // Act
    const allowedAck = await executor.execute(allowed);
    const deniedAck = await executor.execute(denied);

    // Assert
    expect(telegram.callApi).toHaveBeenCalledWith('sendMessage', { chat_id: 100, text: 'agent reply' });
    expect(allowedAck).toMatchObject({ id: 'send-1', ok: true });
    expect(deniedAck).toMatchObject({ id: 'webhook-1', ok: false, errorCode: 400 });
    expect(telegram.callApi).not.toHaveBeenCalledWith('setWebhook', expect.anything());
    expect(onError).toHaveBeenCalledWith(expect.objectContaining({ message: expect.stringContaining('setWebhook') }));
  });
});

describe('Telegraf standalone job puller', () => {
  it('negotiates protocol v2 and acknowledges canonical operation jobs with their lease', async () => {
    // Arrange
    const requests: FetchRecord[] = [];
    let resolveAck: (() => void) | undefined;
    const acked = new Promise<void>((resolve) => { resolveAck = resolve; });
    let pollCount = 0;
    jest.spyOn(globalThis, 'fetch').mockImplementation(async (input, init): Promise<Response> => {
      const url = String(input);
      requests.push({ url, init });
      if (url.endsWith('/api/sdk/v1/jobs/ack')) {
        const ackAttempts = requests.filter((request) => request.url.endsWith('/api/sdk/v1/jobs/ack')).length;
        if (ackAttempts === 1) return response({}, 500);
        resolveAck?.();
        return response({}, 202);
      }
      if (url.includes('/api/sdk/v1/jobs?') && pollCount++ === 0) {
        return response({
          protocolVersion: 2,
          jobs: [
            { id: 'unleased', operation: 'sendDocument', params: { chat_id: 100, document: 'unsafe' } },
            { id: 'job-1', leaseToken: 'lease-1', operation: 'sendMessage', params: { chat_id: 100, text: 'hello' } },
            { id: 'job-2', leaseToken: 'lease-2', operation: 'setWebhook', params: { url: 'https://invalid.example' } },
          ],
        });
      }
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
      });
    });
    const telegram = makeTelegram({ message_id: 93 });
    const puller = new JobPuller({
      apiKey: 'fc_sdk_test',
      apiUrl: API_URL,
      onError: jest.fn(),
      jobContext: new AsyncLocalStorage<string>(),
    });

    // Act
    puller.setTelegram(telegram as unknown as Telegram);
    await acked;
    puller.destroy();

    // Assert
    expect(telegram.callApi).toHaveBeenCalledWith('sendMessage', { chat_id: 100, text: 'hello' });
    expect(telegram.callApi).not.toHaveBeenCalledWith('sendDocument', expect.anything());
    expect(telegram.callApi).not.toHaveBeenCalledWith('setWebhook', expect.anything());
    const poll = requests.find((request) => request.url.includes('/api/sdk/v1/jobs?'));
    expect(poll?.url).toContain('protocolVersion=2');
    expect(poll?.url).toContain('capability=transport.telegram.bot_api.sendMessage');
    const acks = requests.filter((request) => request.url.endsWith('/api/sdk/v1/jobs/ack'));
    expect(acks).toHaveLength(2);
    const ack = acks[1];
    expect(JSON.parse(String(ack?.init?.body))).toEqual({
      protocolVersion: 2,
      results: [
        { id: 'job-1', leaseToken: 'lease-1', ok: true, result: { messageId: 93 } },
        {
          id: 'job-2',
          leaseToken: 'lease-2',
          ok: false,
          error: { code: 400, description: 'method not allowed' },
          errorCode: 400,
          errorDescription: 'method not allowed',
        },
      ],
    });
  });
});
