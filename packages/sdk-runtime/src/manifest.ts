import { conversationKey, ConversationClaims } from './claims';
import type { RuntimeManifest, RuntimeTriggerRule, RuntimeUpdate } from './types';

export interface MatchResult { matched: boolean; rule?: RuntimeTriggerRule; reason?: 'claim' | 'trigger'; }

function matchesText(rule: RuntimeTriggerRule, text: string): boolean {
  if (rule.text === undefined) return rule.kind === 'message';
  const source = rule.text.caseSensitive ? text : text.toLocaleLowerCase();
  const expected = rule.text.caseSensitive ? rule.text.value : rule.text.value.toLocaleLowerCase();
  switch (rule.text.operator) {
    case 'equals': return source === expected;
    case 'contains': return source.includes(expected);
    case 'starts_with': return source.startsWith(expected);
    case 'regex':
      try { return new RegExp(rule.text.value, rule.text.caseSensitive ? '' : 'i').test(text); } catch { return false; }
  }
}

function ruleMatches(rule: RuntimeTriggerRule, update: RuntimeUpdate): boolean {
  if (rule.chatTypes !== undefined && (update.chatType === undefined || !rule.chatTypes.includes(update.chatType))) return false;
  if (rule.visibility === 'addressed' && update.addressed !== true) return false;
  switch (rule.kind) {
    case 'command': return update.command !== undefined && update.command.replace(/^\//, '').split('@')[0] === (rule.command ?? '').replace(/^\//, '');
    case 'deep_link': return update.command?.replace(/^\//, '') === 'start' && (rule.text === undefined || (update.commandPayload !== undefined && matchesText(rule, update.commandPayload)));
    case 'message': return update.text !== undefined && matchesText(rule, update.text);
    case 'callback': return update.callbackData !== undefined && (rule.callbackData?.exact === update.callbackData || (rule.callbackData?.prefix !== undefined && update.callbackData.startsWith(rule.callbackData.prefix)));
    case 'event': return update.eventType !== undefined && update.eventType === rule.eventType;
  }
}

export function matchManifest(manifest: RuntimeManifest | undefined, claims: ConversationClaims, update: RuntimeUpdate, now = Date.now()): MatchResult {
  if (update.chatId !== undefined) {
    const actorClaim = claims.get(conversationKey(update.chatId, update.actorId), now);
    const chatClaim = claims.get(conversationKey(update.chatId, undefined, 'chat'), now);
    if (actorClaim !== undefined || chatClaim !== undefined) return { matched: true, reason: 'claim' };
  }
  if (manifest === undefined) return { matched: false };
  const rule = manifest.rules.slice().sort((a, b) => (b.priority ?? 0) - (a.priority ?? 0)).find((candidate) => ruleMatches(candidate, update));
  return rule === undefined ? { matched: false } : { matched: true, rule, reason: 'trigger' };
}
