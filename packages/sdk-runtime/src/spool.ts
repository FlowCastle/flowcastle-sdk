/** Bounded in-memory spool used as an outage buffer by all language adapters. */
export interface SpoolEntry<T> { value: T; at: number; }

export class BoundedEventSpool<T> {
  private readonly events: SpoolEntry<T>[] = [];
  private dropped = 0;

  public constructor(private readonly maxItems = 1000, private readonly maxAgeMs = 5 * 60_000) {}

  public push(value: T, now = Date.now()): void {
    this.prune(now);
    if (this.events.length >= this.maxItems) { this.events.shift(); this.dropped += 1; }
    this.events.push({ value, at: now });
  }

  public drain(now = Date.now()): { values: T[]; dropped: number } {
    const { entries, dropped } = this.drainEntries(now);
    return { values: entries.map((entry) => entry.value), dropped };
  }

  /** Drain with timestamps so failed delivery can restore original age/order. */
  public drainEntries(now = Date.now()): { entries: SpoolEntry<T>[]; dropped: number } {
    this.prune(now);
    const entries = this.events.splice(0);
    const dropped = this.dropped;
    this.dropped = 0;
    return { entries, dropped };
  }

  /** Restore older drained entries ahead of events added during an async flush. */
  public restore(entries: readonly SpoolEntry<T>[], now = Date.now()): void {
    this.events.unshift(...entries);
    this.prune(now);
    while (this.events.length > this.maxItems) { this.events.shift(); this.dropped += 1; }
  }

  public get size(): number { return this.events.length; }

  private prune(now: number): void {
    while (this.events[0] !== undefined && now - this.events[0].at > this.maxAgeMs) { this.events.shift(); this.dropped += 1; }
  }
}
