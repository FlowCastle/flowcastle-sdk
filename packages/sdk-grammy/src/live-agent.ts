/**
 * Best-effort, per-plugin record of which chats currently have a human agent
 * handling them in FlowCastle Live Chat.
 *
 * This is an OPTIMISTIC LOCAL cache, not the source of truth. The authoritative
 * live-agent state lives server-side; this window is only meant to let the host
 * bot cheaply decide whether to suppress its own auto-replies. It is populated
 * locally when the bot calls `requestLiveAgent()` and refreshed when an agent
 * reply is delivered through the {@link JobPuller}. A future iteration may sync
 * the authoritative state down; until then, treat it as a hint that can be stale
 * in both directions.
 */
export class LiveAgentWindow {
  private readonly expiries = new Map<string, number>();

  /**
   * @param windowMs How long a chat stays flagged active after the last signal.
   * @param now Injectable clock (defaults to `Date.now`) — swapped in tests.
   */
  constructor(
    private readonly windowMs: number,
    private readonly now: () => number = () => Date.now(),
  ) {}

  private key(chatId: number | string): string {
    return String(chatId);
  }

  /** (Re)open the live-agent window for a chat: active until `now + windowMs`. */
  touch(chatId: number | string): void {
    this.expiries.set(this.key(chatId), this.now() + this.windowMs);
  }

  /**
   * Best-effort: is this chat within an unexpired live-agent window? Lazily
   * evicts the entry when it has expired.
   */
  isActive(chatId: number | string): boolean {
    const key = this.key(chatId);
    const expiresAt = this.expiries.get(key);
    if (expiresAt === undefined) {
      return false;
    }
    if (expiresAt <= this.now()) {
      this.expiries.delete(key);
      return false;
    }
    return true;
  }
}
