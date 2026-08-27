import { BoundedEventSpool } from './spool';
import { parseConversationClaimSnapshot, parseRunFlowResult, parseRuntimeManifest } from './protocol';
import type { ConversationClaimSnapshot, JsonObject, RunFlowRequest, RunFlowResult, RuntimeIdentity, RuntimeManifest } from './types';

export interface RuntimeClientOptions {
  apiKey: string;
  apiUrl: string;
  onError?: (error: unknown) => void;
  spool?: BoundedEventSpool<JsonObject>;
}

export interface ManifestResponse { manifest?: RuntimeManifest; notModified: boolean; }

/** HTTP client shared by grammY, Python and other transport adapters. */
export class RuntimeClient {
  private readonly apiUrl: string;
  private readonly onError: (error: unknown) => void;
  private etag: string | undefined;
  private flushingSpool = false;
  public readonly spool: BoundedEventSpool<JsonObject>;

  public constructor(private readonly options: RuntimeClientOptions) {
    this.apiUrl = options.apiUrl.replace(/\/+$/, '');
    this.onError = options.onError ?? (() => undefined);
    this.spool = options.spool ?? new BoundedEventSpool<JsonObject>();
  }

  public async fetchManifest(): Promise<ManifestResponse> {
    const headers: Record<string, string> = this.headers();
    if (this.etag !== undefined) headers['If-None-Match'] = this.etag;
    try {
      const response = await fetch(`${this.apiUrl}/api/sdk/v1/manifest`, { headers });
      if (response.status === 304) return { notModified: true };
      if (!response.ok) throw new Error(`FlowCastle: manifest request failed (${response.status})`);
      const manifest = parseRuntimeManifest(await response.json());
      if (manifest === undefined) throw new Error('FlowCastle: invalid runtime manifest');
      this.etag = response.headers.get('etag') ?? manifest.version;
      return { manifest, notModified: false };
    } catch (error) {
      this.report(error);
      return { notModified: false };
    }
  }

  /** Fetches an initial active-claim snapshot or generation-safe deltas after a cursor. */
  public async fetchClaims(cursor?: string): Promise<ConversationClaimSnapshot | undefined> {
    try {
      const query = cursor === undefined ? '' : `?cursor=${encodeURIComponent(cursor)}`;
      const response = await fetch(`${this.apiUrl}/api/sdk/v1/claims${query}`, { headers: this.headers() });
      if (!response.ok) throw new Error(`FlowCastle: claims request failed (${response.status})`);
      const snapshot = parseConversationClaimSnapshot(await response.json());
      if (snapshot === undefined) throw new Error('FlowCastle: invalid conversation claim snapshot');
      return snapshot;
    } catch (error) {
      this.report(error);
      return undefined;
    }
  }

  public async ingest(event: JsonObject): Promise<boolean> {
    const delivered = await this.postEvent(event);
    if (!delivered) this.spool.push(event);
    return delivered;
  }

  private async postEvent(event: JsonObject): Promise<boolean> {
    try {
      const response = await fetch(`${this.apiUrl}/api/sdk/v1/events`, {
        method: 'POST', headers: { ...this.headers(), 'Content-Type': 'application/json' },
        body: JSON.stringify({ sdkVersion: 'runtime-v2', events: [event] }),
      });
      if (!response.ok) throw new Error(`FlowCastle: event ingest failed (${response.status})`);
      return true;
    } catch (error) {
      this.report(error);
      return false;
    }
  }

  public async flushSpool(): Promise<void> {
    if (this.flushingSpool) return;
    this.flushingSpool = true;
    const { entries, dropped } = this.spool.drainEntries();
    try {
      if (dropped > 0) this.report(new Error(`FlowCastle: dropped ${dropped} runtime event(s) from outage spool`));
      for (let index = 0; index < entries.length; index += 1) {
        if (await this.postEvent(entries[index].value)) continue;
        this.spool.restore(entries.slice(index));
        return;
      }
    } finally {
      this.flushingSpool = false;
    }
  }

  public async runFlow(request: RunFlowRequest): Promise<RunFlowResult> {
    const response = await fetch(`${this.apiUrl}/api/sdk/v1/runtime-runs`, {
      method: 'POST', headers: { ...this.headers(), 'Content-Type': 'application/json' }, body: JSON.stringify(request),
    });
    if (!response.ok) throw new Error(`FlowCastle: run flow request failed (${response.status})`);
    const result = parseRunFlowResult(await response.json());
    if (result === undefined) throw new Error('FlowCastle: invalid run flow response');
    return result;
  }

  public async heartbeat(identity: RuntimeIdentity): Promise<boolean> {
    try {
      const response = await fetch(`${this.apiUrl}/api/sdk/v1/runtime/heartbeat`, {
        method: 'POST', headers: { ...this.headers(), 'Content-Type': 'application/json' }, body: JSON.stringify(identity),
      });
      if (!response.ok) throw new Error(`FlowCastle: runtime heartbeat failed (${response.status})`);
      return true;
    } catch (error) { this.report(error); return false; }
  }

  public headers(): Record<string, string> { return { Authorization: `Bearer ${this.options.apiKey}` }; }
  public baseUrl(): string { return this.apiUrl; }
  private report(error: unknown): void { try { this.onError(error); } catch { /* observability cannot break bot */ } }
}
