/** Best-effort local hint for chats currently handled by a live agent. */
export class LiveAgentWindow {
  private readonly expiries = new Map<string, number>();

  public constructor(private readonly windowMs: number, private readonly now: () => number = () => Date.now()) {}

  public touch(chatId: number | string): void {
    this.expiries.set(String(chatId), this.now() + this.windowMs);
  }

  public isActive(chatId: number | string): boolean {
    const key = String(chatId);
    const expiresAt = this.expiries.get(key);
    if (expiresAt === undefined) return false;
    if (expiresAt <= this.now()) {
      this.expiries.delete(key);
      return false;
    }
    return true;
  }
}
