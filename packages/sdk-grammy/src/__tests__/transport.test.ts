import type { SdkEvent, SdkUpdateEvent } from '../events';
import { Transport } from '../transport';

function makeUpdateEvent(i: number): SdkUpdateEvent {
  return { type: 'update', at: i, update: { update_id: i } };
}

function makeTransport(onError: jest.Mock): Transport {
  return new Transport({
    apiKey: 'k',
    apiUrl: 'https://ingest.test',
    // Never auto-flush on interval or batch size during these tests.
    flushIntervalMs: 1_000_000,
    maxBatchSize: 1_000_000,
    onError,
  });
}

function shippedEvents(spy: jest.SpyInstance): SdkEvent[] {
  return spy.mock.calls.flatMap((call) => {
    const body = (call[1] as RequestInit).body as string;
    return (JSON.parse(body) as { events: SdkEvent[] }).events;
  });
}

afterEach(() => {
  jest.restoreAllMocks();
});

describe('Transport ring buffer', () => {
  it('drops oldest events at the 500 cap and reports the drop count once per flush', async () => {
    const onError = jest.fn();
    const fetchSpy = jest.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(null, { status: 202 }));
    const transport = makeTransport(onError);
    try {
      for (let i = 0; i < 600; i += 1) {
        transport.enqueue(makeUpdateEvent(i));
      }
      await transport.flush();

      const shipped = shippedEvents(fetchSpy) as SdkUpdateEvent[];
      expect(shipped).toHaveLength(500);
      expect((shipped[0].update as { update_id: number }).update_id).toBe(100);
      expect((shipped[shipped.length - 1].update as { update_id: number }).update_id).toBe(599);
      // 500 events shipped in batches of 50 → 10 requests.
      expect(fetchSpy).toHaveBeenCalledTimes(10);
      // 100 events dropped, surfaced exactly once.
      expect(onError).toHaveBeenCalledTimes(1);
      expect(onError).toHaveBeenCalledWith(expect.any(Error));
    } finally {
      transport.destroy();
    }
  });
});

describe('Transport delivery semantics', () => {
  it('retries once on 5xx then drops the batch', async () => {
    const onError = jest.fn();
    const fetchSpy = jest.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(null, { status: 503 }));
    const transport = makeTransport(onError);
    try {
      transport.enqueue(makeUpdateEvent(1));
      await transport.flush();
      expect(fetchSpy).toHaveBeenCalledTimes(2);
      expect(onError).toHaveBeenCalledWith(expect.any(Error));
    } finally {
      transport.destroy();
    }
  });

  it('stops retrying on 401 and reports once without throwing', async () => {
    const onError = jest.fn();
    const fetchSpy = jest.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(null, { status: 401 }));
    const transport = makeTransport(onError);
    try {
      transport.enqueue(makeUpdateEvent(1));
      await expect(transport.flush()).resolves.toBeUndefined();
      expect(fetchSpy).toHaveBeenCalledTimes(1);
      expect(onError).toHaveBeenCalledWith(expect.any(Error));
    } finally {
      transport.destroy();
    }
  });
});
