import type { SdkEvent } from './events';
import { SDK_VERSION } from './version';

const RING_CAP = 500;
const MAX_EVENTS_PER_REQUEST = 50;

export interface TransportOptions {
  apiKey: string;
  apiUrl: string;
  flushIntervalMs: number;
  maxBatchSize: number;
  onError: (error: unknown) => void;
}

/** Bounded, best-effort event transport that cannot break the bot. */
export class Transport {
  private readonly buffer: SdkEvent[] = [];
  private flushing = false;
  private droppedSinceFlush = 0;
  private readonly timer: ReturnType<typeof setInterval>;
  private readonly beforeExitHandler: () => void;

  public constructor(private readonly options: TransportOptions) {
    this.timer = setInterval(() => { void this.flush(); }, options.flushIntervalMs);
    if (typeof this.timer.unref === 'function') this.timer.unref();
    this.beforeExitHandler = () => { void this.flush(); };
    process.once('beforeExit', this.beforeExitHandler);
  }

  public enqueue(event: SdkEvent): void {
    if (this.buffer.length >= RING_CAP) {
      this.buffer.shift();
      this.droppedSinceFlush += 1;
    }
    this.buffer.push(event);
    if (this.buffer.length >= this.options.maxBatchSize) void this.flush();
  }

  public async flush(): Promise<void> {
    if (this.flushing) return;
    this.flushing = true;
    try {
      if (this.droppedSinceFlush > 0) {
        this.report(new Error(`FlowCastle: dropped ${this.droppedSinceFlush} buffered event(s) (buffer full)`));
        this.droppedSinceFlush = 0;
      }
      while (this.buffer.length > 0) await this.send(this.buffer.splice(0, MAX_EVENTS_PER_REQUEST));
    } catch (error) {
      this.report(error);
    } finally {
      this.flushing = false;
    }
    if (this.buffer.length >= this.options.maxBatchSize) void this.flush();
  }

  public destroy(): void {
    clearInterval(this.timer);
    process.removeListener('beforeExit', this.beforeExitHandler);
  }

  private async send(events: SdkEvent[]): Promise<void> {
    const url = `${this.options.apiUrl}/api/sdk/v1/events`;
    let body: string;
    try {
      body = JSON.stringify({ sdkVersion: SDK_VERSION, events });
    } catch (error) {
      this.report(error);
      return;
    }
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        const response = await fetch(url, {
          method: 'POST',
          headers: { Authorization: `Bearer ${this.options.apiKey}`, 'Content-Type': 'application/json' },
          body,
        });
        if (response.status === 401) {
          this.report(new Error('FlowCastle: ingest rejected apiKey (401)'));
          return;
        }
        if (response.status >= 500 && attempt === 0) continue;
        if (response.status >= 500) this.report(new Error(`FlowCastle: ingest server error ${response.status}, dropping batch`));
        return;
      } catch (error) {
        if (attempt === 0) continue;
        this.report(error);
      }
    }
  }

  private report(error: unknown): void {
    try { this.options.onError(error); } catch { /* observability cannot break bot */ }
  }
}
