import { encodeJobAcks, parseRuntimeJobs } from './protocol';
import type { RuntimeJob, RuntimeJobAck } from './types';

export interface RuntimeJobExecutor { execute(job: RuntimeJob): Promise<RuntimeJobAck>; }
export interface RuntimeJobLoopOptions {
  apiKey: string;
  apiUrl: string;
  executor: RuntimeJobExecutor;
  onError?: (error: unknown) => void;
  waitMs?: number;
  maxJobs?: number;
  /** Methods/features this adapter can safely execute, used during leasing. */
  capabilities?: string[];
}

/** Framework-neutral leased-job puller. The adapter owns actual API dispatch. */
export class RuntimeJobLoop {
  private running = false;
  private controller: AbortController | undefined;
  private delayTimer: ReturnType<typeof setTimeout> | undefined;
  private backoffMs = 1000;
  private readonly apiUrl: string;
  private readonly onError: (error: unknown) => void;
  private readonly waitMs: number;
  private readonly maxJobs: number;
  private readonly capabilities: string[];

  public constructor(private readonly options: RuntimeJobLoopOptions) {
    this.apiUrl = options.apiUrl.replace(/\/+$/, '');
    this.onError = options.onError ?? (() => undefined);
    this.waitMs = options.waitMs ?? 25_000;
    this.maxJobs = options.maxJobs ?? 10;
    this.capabilities = options.capabilities ?? [];
  }

  public start(): void { if (!this.running) { this.running = true; void this.run(); } }
  public stop(): void { this.running = false; this.controller?.abort(); if (this.delayTimer !== undefined) clearTimeout(this.delayTimer); }

  private async run(): Promise<void> {
    while (this.running) {
      try {
        const jobs = await this.poll();
        this.backoffMs = 1000;
        if (jobs.length > 0) await this.ack(await this.executeSequentially(jobs));
        else await this.delay(50);
      } catch (error) {
        if (!this.running) return;
        this.report(error);
        await this.delay(this.backoffMs);
        this.backoffMs = Math.min(this.backoffMs * 2, 30_000);
      }
    }
  }

  private async executeSequentially(jobs: RuntimeJob[]): Promise<RuntimeJobAck[]> {
    const results: RuntimeJobAck[] = [];
    for (const job of jobs) {
      try { results.push(await this.options.executor.execute(job)); }
      catch (error) { this.report(error); results.push({ id: job.id, leaseToken: job.leaseToken, ok: false, errorDescription: error instanceof Error ? error.message : 'job execution failed' }); }
    }
    return results;
  }

  private async poll(): Promise<RuntimeJob[]> {
    this.controller = new AbortController();
    const timeout = setTimeout(() => this.controller?.abort(), this.waitMs + 5_000);
    try {
      const capabilityQuery = this.capabilities.map((capability) => `capability=${encodeURIComponent(capability)}`).join('&');
      const query = `waitMs=${this.waitMs}&max=${this.maxJobs}&protocolVersion=2${capabilityQuery.length === 0 ? '' : `&${capabilityQuery}`}`;
      const response = await fetch(`${this.apiUrl}/api/sdk/v1/jobs?${query}`, {
        headers: { Authorization: `Bearer ${this.options.apiKey}` }, signal: this.controller.signal,
      });
      if (!response.ok) throw new Error(`FlowCastle: jobs poll failed (${response.status})`);
      return parseRuntimeJobs(await response.json());
    } finally { clearTimeout(timeout); this.controller = undefined; }
  }

  private async ack(results: RuntimeJobAck[]): Promise<void> {
    const response = await fetch(`${this.apiUrl}/api/sdk/v1/jobs/ack`, {
      method: 'POST', headers: { Authorization: `Bearer ${this.options.apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ protocolVersion: 2, ...encodeJobAcks(results) }),
    });
    if (!response.ok) throw new Error(`FlowCastle: job ack failed (${response.status})`);
  }

  private delay(ms: number): Promise<void> { return new Promise((resolve) => { this.delayTimer = setTimeout(resolve, ms); }); }
  private report(error: unknown): void { try { this.onError(error); } catch { /* no-op */ } }
}
