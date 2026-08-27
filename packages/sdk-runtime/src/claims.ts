import type { ConversationClaim, ConversationKey } from './types';

export class ConversationClaims {
  private readonly claims = new Map<ConversationKey, ConversationClaim>();

  public set(claim: ConversationClaim): void {
    const existing = this.get(claim.conversationKey);
    if (existing === undefined || claim.generation >= existing.generation) this.claims.set(claim.conversationKey, claim);
  }

  public get(key: ConversationKey, now = Date.now()): ConversationClaim | undefined {
    const claim = this.claims.get(key);
    if (claim !== undefined && claim.expiresAt <= now) {
      this.claims.delete(key);
      return undefined;
    }
    return claim;
  }

  public clear(key: ConversationKey, generation?: number): void {
    const existing = this.claims.get(key);
    if (existing !== undefined && (generation === undefined || generation >= existing.generation)) this.claims.delete(key);
  }

  public snapshot(now = Date.now()): ConversationClaim[] {
    return [...this.claims.keys()].flatMap((key) => {
      const claim = this.get(key, now);
      return claim === undefined ? [] : [claim];
    });
  }
}

export function conversationKey(chatId: string | number, actorId?: string | number, scope: 'chat' | 'chat_actor' = 'chat_actor'): ConversationKey {
  return scope === 'chat' || actorId === undefined ? String(chatId) : `${String(chatId)}:${String(actorId)}`;
}
