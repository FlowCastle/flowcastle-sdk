import type { SdkEvent } from './events';
import { SDK_VERSION } from './version';

/** Ring buffer hard cap; oldest events are dropped once exceeded. */
const RING_CAP = 500;
/** Server-enforced maximum events per ingest request. */
const MAX_EVENTS_PER_REQUEST = 50;

export interface TransportOptions {
  apiKey: string;
  /** Normalized base URL (no trailing slash). */
  apiUrl: string;
  flushIntervalMs: number;
  /** Already clamped to [1, 50] by the caller. */
  maxBatchSize: number;
  onError: (error: unknown) => void;
}

/**
 * In-memory batching transport. Buffers events and ships them to the FlowCastle
 * ingest endpoint. Contract: never throws to callers, never blocks the hot path,
 * drops data rather than growing unbounded or retrying forever.
 */
export class Transport {
  private readonly buffer: SdkEvent[] = [];
  private flushing = false;
  private droppedSinceFlush = 0;
  private readonly timer: ReturnType<typeof setInterval>;
  private readonly beforeExitHandler: () => void;

  constructor(private readonly options: TransportOptions) {
    this.timer = setInterval(() => {
      void this.flush();
    }, options.flushIntervalMs);
    // Do not keep the host process alive on our account.
    if (typeof this.timer.unref === 'function') {
      this.timer.unref();
    }
    this.beforeExitHandler = () => {
      void this.flush();
    };
    process.once('beforeExit', this.beforeExitHandler);
  }

  /** Buffer an event (drop-oldest at cap). Triggers a flush when the batch size is reached. */
  enqueue(event: SdkEvent): void {
    if (this.buffer.length >= RING_CAP) {
      this.buffer.shift();
      this.droppedSinceFlush += 1;
    }
    this.buffer.push(event);
    if (this.buffer.length >= this.options.maxBatchSize) {
      void this.flush();
    }
  }

  /**
   * Ship buffered events in requests of up to 50. At most one flush runs at a
   * time; re-checks the buffer afterwards. Never rejects.
   */
  async flush(): Promise<void> {
    if (this.flushing) {
      return;
    }
    this.flushing = true;
    try {
      if (this.droppedSinceFlush > 0) {
        const dropped = this.droppedSinceFlush;
        this.droppedSinceFlush = 0;
        this.report(new Error(`FlowCastle: dropped ${dropped} buffered event(s) (buffer full)`));
      }
      while (this.buffer.length > 0) {
        const batch = this.buffer.splice(0, MAX_EVENTS_PER_REQUEST);
        await this.send(batch);
      }
    } catch (error) {
      // Defensive: send() swallows its own errors, but never let flush reject.
      this.report(error);
    } finally {
      this.flushing = false;
    }
    if (this.buffer.length >= this.options.maxBatchSize) {
      void this.flush();
    }
  }

  /** Clear the interval and detach the exit handler. Intended for host teardown / tests. */
  destroy(): void {
    clearInterval(this.timer);
    process.removeListener('beforeExit', this.beforeExitHandler);
  }

  /**
   * POST a single batch. One retry on network error or 5xx, then drop. 401 stops
   * retrying (reported once) without disabling the plugin. Never throws.
   */
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
          headers: {
            Authorization: `Bearer ${this.options.apiKey}`,
            'Content-Type': 'application/json',
          },
          body,
        });

        if (response.status === 401) {
          this.report(new Error('FlowCastle: ingest rejected apiKey (401)'));
          return;
        }
        if (response.status >= 500) {
          if (attempt === 0) {
            continue;
          }
          this.report(new Error(`FlowCastle: ingest server error ${response.status}, dropping batch`));
          return;
        }
        // 2xx (accepted) or non-retryable 4xx — done either way.
        return;
      } catch (error) {
        // Network-level failure.
        if (attempt === 0) {
          continue;
        }
        this.report(error);
        return;
      }
    }
  }

  private report(error: unknown): void {
    try {
      this.options.onError(error);
    } catch {
      // onError must never break us.
    }
  }
}
