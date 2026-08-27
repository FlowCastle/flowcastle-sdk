import { BoundedEventSpool, conversationKey, ConversationClaims, matchManifest, negotiateCapabilities, parseConversationClaimSnapshot, parseRuntimeJobs, RuntimeClient, RuntimeJobLoop } from '..';
import type { RuntimeManifest, RuntimeUpdate } from '..';

const manifest: RuntimeManifest = {
  protocolVersion: 2,
  version: 'v1',
  requiredCapabilities: ['telegram.send_message'],
  rules: [
    { id: 'start', flowId: 'welcome', kind: 'command', command: 'start', priority: 10 },
    { id: 'callback', flowId: 'menu', kind: 'callback', callbackData: { exact: 'fc:v1:menu' } },
  ],
};

const baseUpdate: RuntimeUpdate = { chatId: 10, actorId: 20, chatType: 'private', raw: {} };

describe('library-neutral runtime protocol', () => {
  it('matches exact flow triggers and active conversation claims', () => {
    const claims = new ConversationClaims();

    expect(matchManifest(manifest, claims, { ...baseUpdate, command: '/start' }).rule?.flowId).toBe('welcome');
    expect(matchManifest(manifest, claims, { ...baseUpdate, callbackData: 'fc:v1:other' }).matched).toBe(false);

    claims.set({ conversationKey: conversationKey(10, 20), generation: 1, kinds: ['reply_wait'], expiresAt: 2_000 });
    expect(matchManifest(manifest, claims, { ...baseUpdate, text: 'anything' }, 1_000)).toMatchObject({ matched: true, reason: 'claim' });
    expect(matchManifest(manifest, claims, { ...baseUpdate, text: 'anything' }, 2_000).matched).toBe(false);
  });

  it('rejects malformed jobs and preserves lease tokens for valid jobs', () => {
    const jobs = parseRuntimeJobs({ jobs: [
      { id: 'valid', protocolVersion: 2, kind: 'telegram_call', method: 'sendMessage', leaseToken: 'lease', params: { chat_id: 1, text: 'Hi' } },
      { id: 4, kind: 'telegram_call', params: {} },
    ] });

    expect(jobs).toHaveLength(1);
    expect(jobs[0]).toMatchObject({ id: 'valid', leaseToken: 'lease', method: 'sendMessage' });
  });

  it('parses canonical protocol-v2 transport and control jobs emitted by the API', () => {
    const jobs = parseRuntimeJobs({
      protocolVersion: 2,
      jobs: [
        {
          protocolVersion: 2,
          id: 'transport-1',
          leaseToken: 'lease-transport',
          attempt: 1,
          kind: 'transport_call',
          transport: 'telegram',
          operation: 'sendMessage',
          params: { chat_id: 1, text: 'Hi' },
          priority: 'interactive',
          requiredCapabilities: ['transport.telegram.bot_api.sendMessage'],
          conversationKey: '1',
          needsResult: true,
          origin: 'flowcastle_runtime',
        },
        {
          protocolVersion: 2,
          id: 'control-1',
          leaseToken: 'lease-control',
          attempt: 1,
          kind: 'control',
          transport: 'telegram',
          operation: 'conversation_claim',
          params: {
            conversationKey: '1:2',
            active: true,
            generation: 4,
            kinds: ['reply_wait'],
            expiresAt: 2_000,
          },
          priority: 'interactive',
          requiredCapabilities: [],
          needsResult: false,
          origin: 'flowcastle_runtime',
        },
      ],
    });

    expect(jobs).toHaveLength(2);
    expect(jobs[0]).toMatchObject({
      kind: 'transport_call',
      operation: 'sendMessage',
      method: 'sendMessage',
      conversationKey: '1',
    });
    expect(jobs[1]).toMatchObject({
      kind: 'control',
      operation: 'conversation_claim',
    });
  });

  it('bounds outage spooling and reports unsupported capabilities', () => {
    const spool = new BoundedEventSpool<string>(2, 100);
    spool.push('one', 0); spool.push('two', 1); spool.push('three', 2);

    expect(spool.drain(3)).toEqual({ values: ['two', 'three'], dropped: 1 });
    expect(negotiateCapabilities(manifest, ['telegram.send_message'])).toEqual({ compatible: true, missing: [] });
    expect(negotiateCapabilities(manifest, [])).toEqual({ compatible: false, missing: ['telegram.send_message'] });
  });

  it('restores failed entries ahead of concurrent events without resetting their age', () => {
    const spool = new BoundedEventSpool<string>(3, 100);
    spool.push('old-one', 0);
    spool.push('old-two', 1);
    const drained = spool.drainEntries(10);
    spool.push('new', 20);

    spool.restore(drained.entries, 20);

    expect(spool.drain(21)).toEqual({ values: ['old-one', 'old-two', 'new'], dropped: 0 });
    spool.restore(drained.entries, 20);
    expect(spool.drain(102)).toEqual({ values: [], dropped: 2 });
  });

  it('parses active claims and inactive generation tombstones without framework types', () => {
    expect(parseConversationClaimSnapshot({
      cursor: '2026-08-26T00:00:00.000Z',
      claims: [
        { conversationKey: '10:20', generation: 2, kinds: ['reply_wait'], active: true, expiresAt: 2_000, updatedAt: 1_000 },
        { conversationKey: '10:21', generation: 3, kinds: [], active: false, expiresAt: 0 },
        { conversationKey: 99, generation: 1, kinds: [], active: true, expiresAt: 2_000 },
      ],
    })).toEqual({
      cursor: '2026-08-26T00:00:00.000Z',
      claims: [
        { conversationKey: '10:20', generation: 2, kinds: ['reply_wait'], active: true, expiresAt: 2_000, updatedAt: 1_000 },
        { conversationKey: '10:21', generation: 3, kinds: [], active: false, expiresAt: 0 },
      ],
    });
  });

  it('leases jobs with protocol v2 capabilities and acks with protocol v2', async () => {
    const requests: Array<{ url: string; body?: string }> = [];
    let loop: RuntimeJobLoop;
    jest.spyOn(globalThis, 'fetch').mockImplementation(async (input: unknown, init?: RequestInit): Promise<Response> => {
      const url = String(input);
      requests.push({ url, ...(typeof init?.body === 'string' ? { body: init.body } : {}) });
      if (url.includes('/jobs?')) return new Response(JSON.stringify({ jobs: [{ id: 'j1', kind: 'telegram_call', method: 'sendMessage', params: {} }] }), { status: 200 });
      return new Response(null, { status: 200 });
    });
    loop = new RuntimeJobLoop({
      apiKey: 'key', apiUrl: 'https://runtime.test', capabilities: ['transport.telegram.bot_api.sendMessage'],
      executor: { execute: async (job) => { loop.stop(); return { id: job.id, ok: true, result: { message_id: 1 } }; } },
    });

    loop.start();
    await new Promise<void>((resolve) => setTimeout(resolve, 10));

    expect(requests[0].url).toContain('protocolVersion=2');
    expect(requests[0].url).toContain('capability=transport.telegram.bot_api.sendMessage');
    expect(requests[1].body).toContain('"protocolVersion":2');
    loop.stop();
  });

  it('replays every spooled update in order after repeated outages', async () => {
    const delivered: string[] = [];
    let available = false;
    let failFirstReplay = true;
    jest.spyOn(globalThis, 'fetch').mockImplementation(async (_input: unknown, init?: RequestInit): Promise<Response> => {
      const body = typeof init?.body === 'string' ? init.body : '';
      if (!available || failFirstReplay) {
        if (available) failFirstReplay = false;
        throw new Error('offline');
      }
      delivered.push(body);
      return new Response(null, { status: 202 });
    });
    const client = new RuntimeClient({ apiKey: 'key', apiUrl: 'https://runtime.test' });

    expect(await client.ingest({ id: 'one' })).toBe(false);
    expect(await client.ingest({ id: 'two' })).toBe(false);
    available = true;

    await client.flushSpool();
    expect(delivered).toHaveLength(0);
    await client.flushSpool();

    expect(delivered).toHaveLength(2);
    expect(delivered[0]).toContain('"id":"one"');
    expect(delivered[1]).toContain('"id":"two"');
  });
});
