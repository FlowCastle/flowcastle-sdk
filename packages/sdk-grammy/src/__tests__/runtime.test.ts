import { AsyncLocalStorage } from 'node:async_hooks';
import { Bot, Context } from 'grammy';
import type { Api, ApiClientOptions } from 'grammy';
import type { Update, UserFromGetMe } from 'grammy/types';

import { flowcastle } from '../index';
import type { FlowCastleFlavor } from '../index';
import { GrammyRuntimeJobExecutor, toRuntimeUpdate } from '../runtime';

type TestContext = FlowCastleFlavor<Context>;

function botInfo(): UserFromGetMe {
  return { id: 42, is_bot: true, first_name: 'Test', username: 'test_bot', can_join_groups: true, can_read_all_group_messages: false, can_manage_bots: false, supports_inline_queries: false, can_connect_to_business: false, has_main_web_app: false, has_topics_enabled: false, allows_users_to_create_topics: false, supports_join_request_queries: false };
}

function update(text: string): Update {
  return { update_id: 1, message: { message_id: 1, date: 1, chat: { id: 100, type: 'private', first_name: 'Chat' }, from: { id: 200, is_bot: false, first_name: 'A' }, text } };
}

function apiFetch(): NonNullable<ApiClientOptions['fetch']> {
  return (async (input: unknown): Promise<Response> => {
    const result = String(input).endsWith('/getMe') ? botInfo() : true;
    return new Response(JSON.stringify({ ok: true, result }), { status: 200 });
  }) as unknown as NonNullable<ApiClientOptions['fetch']>;
}

describe('proxy runtime middleware', () => {
  afterEach(() => jest.restoreAllMocks());

  it('consumes a manifest-matched update and exposes explicit callable flows to customer handlers', async () => {
    const runtimeRequests: string[] = [];
    const heartbeats: string[] = [];
    jest.spyOn(globalThis, 'fetch').mockImplementation(async (input: unknown, init?: RequestInit): Promise<Response> => {
      const url = String(input);
      if (url.includes('/manifest')) return new Response(JSON.stringify({ protocolVersion: 2, version: 'v1', rules: [{ id: 'start', flowId: 'welcome', kind: 'command', command: 'start' }] }), { status: 200, headers: { etag: 'v1' } });
      if (url.includes('/runtime-runs')) { runtimeRequests.push(String(init?.body)); return new Response(JSON.stringify({ executionId: 'run-1' }), { status: 202 }); }
      if (url.includes('/runtime/heartbeat')) { heartbeats.push(String(init?.body)); return new Response(null, { status: 202 }); }
      if (url.includes('/jobs')) return new Promise<Response>((_resolve, reject) => init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError'))));
      return new Response(null, { status: 202 });
    });

    const bot = new Bot<TestContext>('42:TOKEN', { client: { fetch: apiFetch() } });
    bot.botInfo = botInfo();
    const middleware = flowcastle<TestContext>({ apiKey: 'fc_sdk_test', apiUrl: 'https://runtime.test', pullJobs: false, runtime: { enabled: true } });
    const handler = jest.fn(async (ctx: TestContext) => ctx.flowcastle.runFlow('manual', { inputs: { source: 'customer' } }));
    bot.use(middleware);
    bot.on('message:text', handler);

    await middleware.ready();
    await bot.handleUpdate(update('/start'));
    expect(handler).not.toHaveBeenCalled();

    await bot.handleUpdate(update('/help'));
    expect(handler).toHaveBeenCalledTimes(1);
    expect(runtimeRequests[0]).toContain('"flowKey":"manual"');
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    expect(heartbeats[0]).toContain('"client":{"name":"grammy","version":"0.4.0"}');
    expect(heartbeats[0]).toContain('"identity":{"platform":"telegram","accountId":"42"');
    expect(heartbeats[0]).toContain('telegram.bot_api');
    expect(heartbeats[0]).toContain('telegram.send_message');
    expect(heartbeats[0]).toContain('transport.telegram.bot_api.sendMessage');
    middleware.destroy();
  });

  it('consumes an unmatched reply when another runtime replica published an active claim', async () => {
    jest.spyOn(globalThis, 'fetch').mockImplementation(async (input: unknown, init?: RequestInit): Promise<Response> => {
      const url = String(input);
      if (url.includes('/manifest')) return new Response(JSON.stringify({ protocolVersion: 2, version: 'empty', rules: [] }), { status: 200 });
      if (url.includes('/claims')) return new Response(JSON.stringify({ cursor: 'c1', claims: [{ conversationKey: '100:200', generation: 4, kinds: ['reply_wait'], active: true, expiresAt: Date.now() + 60_000 }] }), { status: 200 });
      if (url.includes('/jobs')) return new Promise<Response>((_resolve, reject) => init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError'))));
      return new Response(null, { status: 202 });
    });

    const bot = new Bot<TestContext>('42:TOKEN', { client: { fetch: apiFetch() } });
    bot.botInfo = botInfo();
    const middleware = flowcastle<TestContext>({ apiKey: 'fc_sdk_test', apiUrl: 'https://runtime.test', runtime: { enabled: true } });
    const handler = jest.fn();
    bot.use(middleware);
    bot.on('message:text', handler);

    await middleware.ready();
    await bot.handleUpdate(update('reply to a waiting flow'));

    expect(handler).not.toHaveBeenCalled();
    middleware.destroy();
  });

  it('uses the same sanitized update for matching, matched ingest, and explicit runFlow', async () => {
    const eventBodies: string[] = [];
    const runBodies: string[] = [];
    jest.spyOn(globalThis, 'fetch').mockImplementation(async (input: unknown, init?: RequestInit): Promise<Response> => {
      const url = String(input);
      if (url.includes('/manifest')) {
        return new Response(JSON.stringify({
          protocolVersion: 2,
          version: 'privacy-v1',
          rules: [{ id: 'start', flowId: 'welcome', kind: 'command', command: 'start' }],
        }), { status: 200 });
      }
      if (url.includes('/runtime-runs')) {
        runBodies.push(String(init?.body));
        return new Response(JSON.stringify({ executionId: 'run-private' }), { status: 202 });
      }
      if (url.includes('/events')) {
        eventBodies.push(String(init?.body));
        return new Response(null, { status: 202 });
      }
      if (url.includes('/jobs')) {
        return new Promise<Response>((_resolve, reject) => init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError'))));
      }
      return new Response(null, { status: 202 });
    });

    const bot = new Bot<TestContext>('42:TOKEN', { client: { fetch: apiFetch() } });
    bot.botInfo = botInfo();
    const middleware = flowcastle<TestContext>({
      apiKey: 'fc_sdk_test',
      apiUrl: 'https://runtime.test',
      runtime: { enabled: true },
      privacy: { contactFields: [], messageContent: 'routing' },
    });
    const handler = jest.fn(async (ctx: TestContext) => ctx.flowcastle.runFlow('manual'));
    bot.use(middleware);
    bot.on('message:text', handler);

    await middleware.ready();
    await bot.handleUpdate(update('/start secret-referral'));
    expect(handler).not.toHaveBeenCalled();

    await bot.handleUpdate(update('/help private-value'));
    await middleware.flush();

    expect(handler).toHaveBeenCalledTimes(1);
    expect(eventBodies.some((body) => body.includes('"handled":true'))).toBe(true);
    expect(eventBodies.join('\n').match(/"text":"\/start"/g)).toHaveLength(1);
    expect(eventBodies.join('\n')).not.toContain('secret-referral');
    expect(eventBodies.join('\n')).not.toContain('private-value');
    expect(eventBodies.join('\n')).not.toContain('"first_name":"A"');
    expect(runBodies).toHaveLength(1);
    expect(runBodies[0]).toContain('"text":"/help"');
    expect(runBodies[0]).not.toContain('private-value');
    middleware.destroy();
  });
});

describe('proxy runtime Telegram surface', () => {
  it('marks private and explicitly targeted group commands as addressed', () => {
    const privateUpdate = update('/test payload') as unknown as Record<string, unknown>;
    const groupUpdate = {
      update_id: 2,
      message: {
        message_id: 2,
        date: 1,
        chat: { id: -100, type: 'supergroup' },
        from: { id: 200, is_bot: false, first_name: 'A' },
        text: '/test@test_bot payload',
      },
    };

    expect(toRuntimeUpdate(privateUpdate as import('@flowcastle/sdk-runtime').JsonObject, botInfo())).toMatchObject({
      command: 'test', commandPayload: 'payload', addressed: true,
    });
    expect(toRuntimeUpdate(groupUpdate as import('@flowcastle/sdk-runtime').JsonObject, botInfo())).toMatchObject({
      command: 'test', commandPayload: 'payload', addressed: true, chatType: 'supergroup',
    });
  });

  it('dispatches media and payment operations through explicit typed methods', async () => {
    const raw = {
      sendSticker: jest.fn(async () => ({ message_id: 8 })),
      answerPreCheckoutQuery: jest.fn(async () => true),
    };
    const executor = new GrammyRuntimeJobExecutor(
      { raw } as unknown as Api,
      { set: jest.fn(), clear: jest.fn() } as unknown as import('@flowcastle/sdk-runtime').ConversationClaims,
      new AsyncLocalStorage<string>(),
      jest.fn(),
    );

    const sticker = await executor.execute({
      protocolVersion: 2, id: 'sticker-1', leaseToken: 'lease-1', kind: 'telegram_call',
      method: 'sendSticker', params: { chat_id: 100, sticker: 'file-id' },
    });
    const checkout = await executor.execute({
      protocolVersion: 2, id: 'checkout-1', leaseToken: 'lease-2', kind: 'telegram_call',
      method: 'answerPreCheckoutQuery', params: { pre_checkout_query_id: 'query-1', ok: true },
    });

    expect(raw.sendSticker).toHaveBeenCalledWith({ chat_id: 100, sticker: 'file-id' });
    expect(raw.answerPreCheckoutQuery).toHaveBeenCalledWith({ pre_checkout_query_id: 'query-1', ok: true });
    expect(sticker).toMatchObject({ ok: true, leaseToken: 'lease-1' });
    expect(checkout).toMatchObject({ ok: true, leaseToken: 'lease-2' });
  });

  it('executes canonical protocol-v2 transport and conversation-claim jobs', async () => {
    const raw = { sendMessage: jest.fn(async () => ({ message_id: 9 })) };
    const claims = {
      set: jest.fn(),
      clear: jest.fn(),
    };
    const executor = new GrammyRuntimeJobExecutor(
      { raw } as unknown as Api,
      claims as unknown as import('@flowcastle/sdk-runtime').ConversationClaims,
      new AsyncLocalStorage<string>(),
      jest.fn(),
    );

    const delivery = await executor.execute({
      protocolVersion: 2,
      id: 'transport-v2',
      leaseToken: 'lease-v2',
      kind: 'transport_call',
      operation: 'sendMessage',
      params: { chat_id: 100, text: 'Flow reply' },
    });
    const claim = await executor.execute({
      protocolVersion: 2,
      id: 'control-v2',
      leaseToken: 'lease-control',
      kind: 'control',
      operation: 'conversation_claim',
      params: {
        conversationKey: '100:200',
        active: true,
        generation: 5,
        kinds: ['reply_wait'],
        expiresAt: 2_000,
      },
    });

    expect(raw.sendMessage).toHaveBeenCalledWith({ chat_id: 100, text: 'Flow reply' });
    expect(delivery).toMatchObject({ ok: true, result: { message_id: 9 } });
    expect(claims.set).toHaveBeenCalledWith({
      conversationKey: '100:200',
      generation: 5,
      kinds: ['reply_wait'],
      expiresAt: 2_000,
    });
    expect(claim).toMatchObject({ ok: true });
  });
});
