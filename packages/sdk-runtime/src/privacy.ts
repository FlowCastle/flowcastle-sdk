import type { JsonObject, JsonValue } from './types';

export const TELEGRAM_CONTACT_FIELDS = [
  'username',
  'firstName',
  'lastName',
  'languageCode',
  'isPremium',
  'addedToAttachmentMenu',
] as const;

export type TelegramContactField = (typeof TELEGRAM_CONTACT_FIELDS)[number];
export type MessageContentMode = 'full' | 'routing' | 'none';
export type TelegramTextField =
  | 'messageText'
  | 'caption'
  | 'commandArguments'
  | 'callbackData'
  | 'inlineQuery'
  | 'contactVCard'
  | 'buttonText';

export interface TelegramTextTransformContext {
  value: string;
  field: TelegramTextField;
  updateType: string;
}

export type TelegramTextTransformer = (
  context: TelegramTextTransformContext,
) => string | null | Promise<string | null>;

export interface TelegramMessageContentOptions {
  mode: MessageContentMode;
  transformText?: TelegramTextTransformer;
  /** Maximum time allowed for each async transformation. Default `1000`. */
  transformTimeoutMs?: number;
}

/** Framework-neutral privacy contract for Telegram SDK adapters. */
export interface TelegramPrivacyOptions {
  /** Optional Telegram profile fields allowed to leave the bot process. User ids are always retained. */
  contactFields?: readonly TelegramContactField[];
  /** Incoming and observed outgoing content shared with FlowCastle. */
  messageContent?: MessageContentMode | TelegramMessageContentOptions;
}

export interface ResolvedTelegramPrivacyPolicy {
  readonly contactFields: readonly TelegramContactField[];
  readonly messageContent: Readonly<{
    mode: MessageContentMode;
    transformText?: TelegramTextTransformer;
    transformTimeoutMs: number;
  }>;
}

const DEFAULT_TRANSFORM_TIMEOUT_MS = 1000;
const ALL_CONTACT_FIELDS: readonly TelegramContactField[] = [...TELEGRAM_CONTACT_FIELDS];
const CONTACT_KEYS: Readonly<Record<TelegramContactField, string>> = {
  username: 'username',
  firstName: 'first_name',
  lastName: 'last_name',
  languageCode: 'language_code',
  isPremium: 'is_premium',
  addedToAttachmentMenu: 'added_to_attachment_menu',
};

const ENTITY_FIELDS = new Set(['entities', 'caption_entities']);
const STRUCTURED_CONTENT_FIELDS = new Set([
  'animation',
  'audio',
  'contact',
  'dice',
  'document',
  'game',
  'giveaway',
  'giveaway_created',
  'giveaway_completed',
  'giveaway_winners',
  'invoice',
  'location',
  'options',
  'order_info',
  'paid_media',
  'passport_data',
  'photo',
  'poll',
  'poll_answer',
  'proximity_alert_triggered',
  'shipping_address',
  'story',
  'successful_payment',
  'venue',
  'video',
  'video_note',
  'voice',
  'web_app_data',
]);
const MESSAGE_CONTENT_FIELDS = new Set([
  'address',
  'author_signature',
  'bio',
  'caption',
  'caption_entities',
  'city',
  'connected_website',
  'country_code',
  'currency',
  'description',
  'email',
  'entities',
  'explanation',
  'file_name',
  'forward_sender_name',
  'invoice_payload',
  'label',
  'latitude',
  'longitude',
  'horizontal_accuracy',
  'live_period',
  'heading',
  'proximity_alert_radius',
  'name',
  'new_chat_title',
  'paid_media_payload',
  'phone_number',
  'post_code',
  'question',
  'query',
  'quote',
  'shipping_option_id',
  'start_parameter',
  'state',
  'street_line1',
  'street_line2',
  'text',
  'title',
  'total_amount',
  'url',
  'vcard',
]);

const OUTGOING_OPERATIONAL_FIELDS = new Set([
  'action',
  'business_connection_id',
  'callback_query_id',
  'chat_id',
  'direct_messages_topic_id',
  'from_chat_id',
  'inline_message_id',
  'message_id',
  'message_thread_id',
  'pre_checkout_query_id',
  'sender_chat_id',
  'shipping_query_id',
  'until_date',
  'user_id',
]);
const INCOMING_OPERATIONAL_FIELDS = new Set([
  'actor_chat',
  'actor_user',
  'business_connection_id',
  'callback_query',
  'chat',
  'chat_instance',
  'date',
  'edit_date',
  'from',
  'id',
  'is_bot',
  'is_member',
  'message',
  'new_chat_member',
  'old_chat_member',
  'reply_to_message',
  'sender_chat',
  'status',
  'type',
  'user',
  'via_bot',
]);
const INCOMING_OPERATIONAL_ARRAY_FIELDS = new Set(['message_ids']);

type MutableJsonObject = Record<string, JsonValue>;

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function cloneJsonObject(value: unknown): MutableJsonObject | undefined {
  if (!isObject(value)) return undefined;
  return JSON.parse(JSON.stringify(value)) as MutableJsonObject;
}

function normalizeTimeout(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value) || value < 1) return DEFAULT_TRANSFORM_TIMEOUT_MS;
  return Math.floor(value);
}

/**
 * Resolves the public privacy options. Omitting `privacy` preserves pre-policy
 * SDK behavior; explicitly passing `{}` opts into minimal profile data and
 * routing-only message content.
 */
export function resolveTelegramPrivacyPolicy(
  options?: TelegramPrivacyOptions,
  legacyRedactText = false,
): ResolvedTelegramPrivacyPolicy {
  const content = options?.messageContent;
  const contentOptions: TelegramMessageContentOptions = typeof content === 'string'
    ? { mode: content }
    : content ?? { mode: options === undefined && !legacyRedactText ? 'full' : 'routing' };
  const requestedContactFields = options === undefined
    ? ALL_CONTACT_FIELDS
    : options.contactFields ?? [];
  const requestedSet = new Set(requestedContactFields);

  return {
    contactFields: TELEGRAM_CONTACT_FIELDS.filter((field) => requestedSet.has(field)),
    messageContent: {
      mode: contentOptions.mode,
      ...(contentOptions.transformText === undefined ? {} : { transformText: contentOptions.transformText }),
      transformTimeoutMs: normalizeTimeout(contentOptions.transformTimeoutMs),
    },
  };
}

function updateType(update: MutableJsonObject): string {
  return Object.keys(update).find((key) => key !== 'update_id') ?? 'unknown';
}

function isInlineButton(value: MutableJsonObject): boolean {
  return 'callback_data' in value || 'url' in value || 'web_app' in value || 'login_url' in value;
}

function commandParts(value: string): { command: string; payload?: string } | undefined {
  const match = value.match(/^(\/[A-Za-z0-9_]+(?:@[A-Za-z0-9_]+)?)(?:\s+([\s\S]*))?$/);
  if (match === null) return undefined;
  return { command: match[1], ...(match[2] === undefined ? {} : { payload: match[2] }) };
}

function slimInlineKeyboard(value: MutableJsonObject): void {
  const replyMarkup = value.reply_markup;
  if (!isObject(replyMarkup) || !Array.isArray(replyMarkup.inline_keyboard)) {
    delete value.reply_markup;
    return;
  }
  const rows: JsonValue[][] = [];
  for (const row of replyMarkup.inline_keyboard) {
    if (!Array.isArray(row)) continue;
    const buttons: JsonValue[] = [];
    for (const candidate of row) {
      if (!isObject(candidate)) continue;
      const button: MutableJsonObject = {};
      if (typeof candidate.text === 'string') button.text = candidate.text;
      if (typeof candidate.callback_data === 'string') button.callback_data = candidate.callback_data;
      if (typeof candidate.url === 'string') button.url = candidate.url;
      buttons.push(button);
    }
    rows.push(buttons);
  }
  value.reply_markup = { inline_keyboard: rows };
}

export class TelegramPrivacyFilter {
  public readonly policy: ResolvedTelegramPrivacyPolicy;

  public constructor(
    options?: TelegramPrivacyOptions,
    private readonly onError: (error: unknown) => void = () => undefined,
    legacyRedactText = false,
  ) {
    this.policy = resolveTelegramPrivacyPolicy(options, legacyRedactText);
  }

  public async sanitizeUpdate(update: JsonObject): Promise<JsonObject> {
    const clone = cloneJsonObject(update) ?? {};
    const restricted = this.policy.messageContent.mode === 'full'
      ? clone
      : this.restrictIncomingUpdate(clone);
    await this.sanitizeObject(restricted, [], updateType(restricted));
    return restricted;
  }

  private restrictIncomingUpdate(value: MutableJsonObject): MutableJsonObject {
    const restricted: MutableJsonObject = {};
    if (typeof value.update_id === 'number') restricted.update_id = value.update_id;
    for (const [key, candidate] of Object.entries(value)) {
      if (key === 'update_id') continue;
      if (isObject(candidate)) restricted[key] = this.restrictIncomingObject(candidate as MutableJsonObject);
    }
    return restricted;
  }

  private restrictIncomingObject(value: MutableJsonObject): MutableJsonObject {
    const restricted: MutableJsonObject = {};
    const allowedContactKeys = new Set(this.policy.contactFields.map((field) => CONTACT_KEYS[field]));
    for (const [key, candidate] of Object.entries(value)) {
      const isIdentifier = key.endsWith('_id');
      const isTimestamp = key.endsWith('_date');
      const isContentRoute = this.policy.messageContent.mode === 'routing'
        && (key === 'text' || key === 'data' || key === 'callback_data');
      const keep = INCOMING_OPERATIONAL_FIELDS.has(key)
        || allowedContactKeys.has(key)
        || isIdentifier
        || isTimestamp
        || isContentRoute;
      if (!keep) continue;

      if (Array.isArray(candidate)) {
        if (INCOMING_OPERATIONAL_ARRAY_FIELDS.has(key)) restricted[key] = candidate as JsonValue[];
      } else if (isObject(candidate)) {
        restricted[key] = this.restrictIncomingObject(candidate as MutableJsonObject);
      } else {
        restricted[key] = candidate as JsonValue;
      }
    }
    return restricted;
  }

  public async sanitizeOutgoingPayload(payload: unknown): Promise<JsonObject | undefined> {
    const clone = cloneJsonObject(payload);
    if (clone === undefined) return undefined;
    slimInlineKeyboard(clone);
    const restricted = this.policy.messageContent.mode === 'full'
      ? clone
      : this.restrictOutgoingPayload(clone);
    await this.sanitizeObject(restricted, [], 'outgoing');
    return restricted;
  }

  private restrictOutgoingPayload(value: MutableJsonObject): MutableJsonObject {
    const restricted: MutableJsonObject = {};
    for (const field of OUTGOING_OPERATIONAL_FIELDS) {
      const candidate = value[field];
      if (candidate !== undefined) restricted[field] = candidate;
    }
    if (this.policy.messageContent.mode === 'routing' && value.reply_markup !== undefined) {
      restricted.reply_markup = value.reply_markup;
    }
    return restricted;
  }

  private async sanitizeObject(value: MutableJsonObject, path: readonly string[], eventType: string): Promise<void> {
    this.sanitizeContactFields(value);
    await this.sanitizeDirectContent(value, path, eventType);

    for (const [key, child] of Object.entries(value)) {
      if (Array.isArray(child)) {
        await this.sanitizeArray(child, [...path, key], eventType);
      } else if (isObject(child)) {
        await this.sanitizeObject(child as MutableJsonObject, [...path, key], eventType);
      }
    }
  }

  private async sanitizeArray(value: JsonValue[], path: readonly string[], eventType: string): Promise<void> {
    for (const item of value) {
      if (Array.isArray(item)) await this.sanitizeArray(item, path, eventType);
      else if (isObject(item)) await this.sanitizeObject(item as MutableJsonObject, path, eventType);
    }
  }

  private sanitizeContactFields(value: MutableJsonObject): void {
    const allowed = new Set(this.policy.contactFields);
    for (const field of TELEGRAM_CONTACT_FIELDS) {
      if (!allowed.has(field)) delete value[CONTACT_KEYS[field]];
    }
  }

  private async sanitizeDirectContent(
    value: MutableJsonObject,
    path: readonly string[],
    eventType: string,
  ): Promise<void> {
    const { mode } = this.policy.messageContent;
    if (mode !== 'full') {
      for (const field of STRUCTURED_CONTENT_FIELDS) delete value[field];
      for (const field of MESSAGE_CONTENT_FIELDS) {
        if (field !== 'text') delete value[field];
      }
      if (mode === 'none') {
        delete value.text;
        delete value.data;
        delete value.callback_data;
        delete value.reply_markup;
        return;
      }

      await this.sanitizeRoutingText(value, eventType);
      await this.sanitizeCallbackValue(value, path, eventType);
      return;
    }

    await this.transformFullText(value, path, eventType);
  }

  private async sanitizeRoutingText(value: MutableJsonObject, eventType: string): Promise<void> {
    if (typeof value.text !== 'string') return;
    if (isInlineButton(value)) {
      value.text = '[redacted]';
      return;
    }
    const command = commandParts(value.text);
    if (command === undefined) {
      delete value.text;
      return;
    }
    value.text = command.command;
    for (const field of ENTITY_FIELDS) delete value[field];
    void eventType;
  }

  private async sanitizeCallbackValue(
    value: MutableJsonObject,
    path: readonly string[],
    eventType: string,
  ): Promise<void> {
    if (typeof value.callback_data === 'string') {
      const transformed = await this.transform(value.callback_data, 'callbackData', eventType);
      if (transformed === undefined) delete value.callback_data;
      else value.callback_data = transformed;
    }
    if (path[path.length - 1] === 'callback_query' && typeof value.data === 'string') {
      const transformed = await this.transform(value.data, 'callbackData', eventType);
      if (transformed === undefined) delete value.data;
      else value.data = transformed;
    }
  }

  private async transformFullText(
    value: MutableJsonObject,
    path: readonly string[],
    eventType: string,
  ): Promise<void> {
    if (typeof value.text === 'string') {
      if (isInlineButton(value)) {
        await this.assignTransformed(value, 'text', 'buttonText', eventType);
      } else {
        const command = commandParts(value.text);
        if (command?.payload !== undefined) {
          const payload = await this.transform(command.payload, 'commandArguments', eventType);
          if (payload === undefined || payload.length === 0) value.text = command.command;
          else value.text = `${command.command} ${payload}`;
          for (const field of ENTITY_FIELDS) delete value[field];
        } else {
          await this.assignTransformed(value, 'text', 'messageText', eventType, 'entities');
        }
      }
    }
    await this.assignTransformed(value, 'caption', 'caption', eventType, 'caption_entities');
    await this.assignTransformed(value, 'vcard', 'contactVCard', eventType);
    await this.sanitizeCallbackValue(value, path, eventType);
    if ((path[path.length - 1] === 'inline_query' || path[path.length - 1] === 'chosen_inline_result')) {
      await this.assignTransformed(value, 'query', 'inlineQuery', eventType);
    }
  }

  private async assignTransformed(
    value: MutableJsonObject,
    key: string,
    field: TelegramTextField,
    eventType: string,
    entityKey?: string,
  ): Promise<void> {
    const current = value[key];
    if (typeof current !== 'string') return;
    const transformed = await this.transform(current, field, eventType);
    if (transformed === undefined) delete value[key];
    else value[key] = transformed;
    if (this.policy.messageContent.transformText !== undefined && entityKey !== undefined) delete value[entityKey];
  }

  private async transform(
    value: string,
    field: TelegramTextField,
    eventType: string,
  ): Promise<string | undefined> {
    const transformer = this.policy.messageContent.transformText;
    if (transformer === undefined) return value;

    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      const timeoutPromise = new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(
          () => reject(new Error(`transformText timed out after ${this.policy.messageContent.transformTimeoutMs}ms`)),
          this.policy.messageContent.transformTimeoutMs,
        );
      });
      const transformed = await Promise.race([
        Promise.resolve(transformer({ value, field, updateType: eventType })),
        timeoutPromise,
      ]);
      if (transformed === null) return undefined;
      if (typeof transformed !== 'string') throw new TypeError('transformText must return a string or null');
      return transformed;
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      this.report(new Error(`FlowCastle: transformText failed for ${field}; content dropped: ${detail}`));
      return undefined;
    } finally {
      if (timeout !== undefined) clearTimeout(timeout);
    }
  }

  private report(error: unknown): void {
    try {
      this.onError(error);
    } catch {
      // Privacy failures must not escape through observability callbacks.
    }
  }
}
