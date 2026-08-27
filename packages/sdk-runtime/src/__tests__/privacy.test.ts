import {
  resolveTelegramPrivacyPolicy,
  TelegramPrivacyFilter,
} from '../privacy';
import type { JsonObject } from '../types';

function getUpdate(overrides: JsonObject = {}): JsonObject {
  return {
    update_id: 7,
    message: {
      message_id: 11,
      date: 1,
      from: {
        id: 200,
        is_bot: false,
        first_name: 'Ada',
        last_name: 'Lovelace',
        username: 'ada',
        language_code: 'en',
      },
      chat: { id: 100, type: 'private', first_name: 'Ada', username: 'ada' },
      text: 'email ada@example.com',
      entities: [{ type: 'email', offset: 6, length: 15 }],
      location: { latitude: 51.5, longitude: -0.1 },
    },
    ...overrides,
  };
}

describe('TelegramPrivacyFilter', () => {
  it('preserves legacy behavior when privacy settings are not configured', () => {
    const policy = resolveTelegramPrivacyPolicy();

    expect(policy.messageContent.mode).toBe('full');
    expect(policy.contactFields).toEqual([
      'username',
      'firstName',
      'lastName',
      'languageCode',
      'isPremium',
      'addedToAttachmentMenu',
    ]);
  });

  it('uses privacy-preserving defaults when the privacy object is configured', () => {
    const policy = resolveTelegramPrivacyPolicy({});

    expect(policy.messageContent.mode).toBe('routing');
    expect(policy.contactFields).toEqual([]);
  });

  it.each([0, Number.NaN, Number.POSITIVE_INFINITY])('normalizes invalid transform timeout %p', (transformTimeoutMs) => {
    const filter = new TelegramPrivacyFilter({
      messageContent: { mode: 'full', transformTimeoutMs },
    });

    expect(filter.policy.messageContent.transformTimeoutMs).toBe(1000);
  });

  it('keeps mandatory ids, allows selected profile fields, and transforms full message content', async () => {
    const filter = new TelegramPrivacyFilter({
      contactFields: ['username'],
      messageContent: {
        mode: 'full',
        transformText: ({ value }) => value.replace(/ada@example\.com/g, '[EMAIL]'),
      },
    });

    const sanitized = await filter.sanitizeUpdate(getUpdate());
    const message = sanitized.message as JsonObject;
    const from = message.from as JsonObject;

    expect(from).toMatchObject({ id: 200, username: 'ada' });
    expect(from.first_name).toBeUndefined();
    expect(from.last_name).toBeUndefined();
    expect(from.language_code).toBeUndefined();
    expect(message.text).toBe('email [EMAIL]');
    expect(message.entities).toBeUndefined();
  });

  it('keeps only command and callback routing values in routing mode', async () => {
    const filter = new TelegramPrivacyFilter({
      contactFields: [],
      messageContent: 'routing',
    });
    const sanitized = await filter.sanitizeUpdate({
      ...getUpdate(),
      message: {
        ...(getUpdate().message as JsonObject),
        text: '/start private-referral',
      },
      callback_query: {
        id: 'callback-1',
        from: { id: 200, first_name: 'Ada' },
        data: 'menu:buy',
        message: {
          message_id: 12,
          date: 1,
          chat: { id: 100, type: 'private', first_name: 'Ada' },
          text: 'Sensitive previous message',
        },
      },
      inline_query: {
        id: 'inline-1',
        from: { id: 200, first_name: 'Ada' },
        query: 'private search',
        offset: '',
      },
      chat_join_request: {
        chat: { id: -100, type: 'supergroup', title: 'Private group' },
        from: { id: 200, first_name: 'Ada' },
        user_chat_id: 201,
        date: 1,
        bio: 'Private biography',
      },
    });

    const message = sanitized.message as JsonObject;
    const callback = sanitized.callback_query as JsonObject;
    const callbackMessage = callback.message as JsonObject;
    const inlineQuery = sanitized.inline_query as JsonObject;

    expect(message.text).toBe('/start');
    expect(message.location).toBeUndefined();
    expect((message.from as JsonObject).first_name).toBeUndefined();
    expect(callback.data).toBe('menu:buy');
    expect(callbackMessage.text).toBeUndefined();
    expect(inlineQuery.query).toBeUndefined();
    expect(((sanitized.chat_join_request as JsonObject).chat as JsonObject).title).toBeUndefined();
    expect((sanitized.chat_join_request as JsonObject).bio).toBeUndefined();
  });

  it('removes structured payment and address content in routing mode without mutating the source update', async () => {
    const source: JsonObject = {
      update_id: 9,
      pre_checkout_query: {
        id: 'checkout-1',
        from: { id: 200, first_name: 'Ada' },
        currency: 'EUR',
        total_amount: 9900,
        invoice_payload: 'customer:private-order',
        order_info: {
          name: 'Ada Lovelace',
          email: 'ada@example.com',
          shipping_address: { city: 'London', street_line1: 'Private Street' },
        },
      },
    };
    const filter = new TelegramPrivacyFilter({ messageContent: 'routing' });

    const sanitized = await filter.sanitizeUpdate(source);
    const checkout = sanitized.pre_checkout_query as JsonObject;

    expect(checkout).toMatchObject({ id: 'checkout-1', from: { id: 200 } });
    expect(checkout.currency).toBeUndefined();
    expect(checkout.total_amount).toBeUndefined();
    expect(checkout.invoice_payload).toBeUndefined();
    expect(checkout.order_info).toBeUndefined();
    expect(((source.pre_checkout_query as JsonObject).order_info as JsonObject).email).toBe('ada@example.com');
  });

  it('removes command and callback routing values in none mode', async () => {
    const filter = new TelegramPrivacyFilter({ messageContent: 'none' });

    const sanitized = await filter.sanitizeUpdate({
      ...getUpdate(),
      message: { ...(getUpdate().message as JsonObject), text: '/start secret' },
      callback_query: { id: 'callback-1', from: { id: 200 }, data: 'menu:buy' },
    });

    expect((sanitized.message as JsonObject).text).toBeUndefined();
    expect((sanitized.callback_query as JsonObject).data).toBeUndefined();
  });

  it('drops a field and reports the error when an async transformer fails', async () => {
    const onError = jest.fn();
    const filter = new TelegramPrivacyFilter(
      {
        messageContent: {
          mode: 'full',
          transformText: async () => {
            throw new Error('DLP unavailable');
          },
        },
      },
      onError,
    );

    const sanitized = await filter.sanitizeUpdate(getUpdate());

    expect((sanitized.message as JsonObject).text).toBeUndefined();
    expect(onError).toHaveBeenCalledWith(expect.objectContaining({ message: expect.stringContaining('DLP unavailable') }));
  });

  it('provides field context and permits individual values to be removed', async () => {
    const fields: string[] = [];
    const filter = new TelegramPrivacyFilter({
      messageContent: {
        mode: 'full',
        transformText: ({ value, field }) => {
          fields.push(field);
          if (field === 'contactVCard') return null;
          return value.replace('private', '[SAFE]');
        },
      },
    });

    const sanitized = await filter.sanitizeUpdate({
      update_id: 8,
      message: {
        message_id: 12,
        date: 1,
        chat: { id: 100, type: 'private' },
        from: { id: 200, is_bot: false },
        text: '/start private-code',
        contact: { phone_number: '+123', first_name: 'Ada', vcard: 'private-vcard' },
      },
      callback_query: { id: 'callback-1', from: { id: 200 }, data: 'private-action' },
    });

    expect((sanitized.message as JsonObject).text).toBe('/start [SAFE]-code');
    expect(((sanitized.message as JsonObject).contact as JsonObject).vcard).toBeUndefined();
    expect((sanitized.callback_query as JsonObject).data).toBe('[SAFE]-action');
    expect(fields).toEqual(expect.arrayContaining(['commandArguments', 'contactVCard', 'callbackData']));
  });

  it('times out an async transformer and drops the pending field', async () => {
    const onError = jest.fn();
    const filter = new TelegramPrivacyFilter(
      {
        messageContent: {
          mode: 'full',
          transformTimeoutMs: 5,
          transformText: () => new Promise<string | null>(() => undefined),
        },
      },
      onError,
    );

    const sanitized = await filter.sanitizeUpdate(getUpdate());

    expect((sanitized.message as JsonObject).text).toBeUndefined();
    expect(onError).toHaveBeenCalledWith(expect.objectContaining({ message: expect.stringContaining('timed out') }));
  });

  it('sanitizes outgoing content while preserving keyboard routing structure', async () => {
    const filter = new TelegramPrivacyFilter({ messageContent: 'routing' });

    const sanitized = await filter.sanitizeOutgoingPayload({
      chat_id: 100,
      text: 'Hello Ada',
      reply_markup: {
        inline_keyboard: [[{ text: 'Buy now', callback_data: 'buy:1', web_app: { url: 'https://private.example' } }]],
      },
    });

    expect(sanitized).toEqual({
      chat_id: 100,
      reply_markup: {
        inline_keyboard: [[{ text: '[redacted]', callback_data: 'buy:1' }]],
      },
    });
  });

  it('uses an operational allowlist for restricted outgoing location and venue payloads', async () => {
    const routing = new TelegramPrivacyFilter({ messageContent: 'routing' });
    const none = new TelegramPrivacyFilter({ messageContent: 'none' });
    const payload = {
      chat_id: 100,
      latitude: 51.5,
      longitude: -0.1,
      title: 'Private venue',
      address: 'Private Street',
      reply_markup: { inline_keyboard: [[{ text: 'Map', url: 'https://maps.example/private' }]] },
    };

    await expect(routing.sanitizeOutgoingPayload(payload)).resolves.toEqual({
      chat_id: 100,
      reply_markup: { inline_keyboard: [[{}]] },
    });
    await expect(none.sanitizeOutgoingPayload(payload)).resolves.toEqual({ chat_id: 100 });
  });

  it('removes nested URLs from incoming updates in none mode', async () => {
    const filter = new TelegramPrivacyFilter({ messageContent: 'none' });

    const sanitized = await filter.sanitizeUpdate({
      update_id: 10,
      message: {
        message_id: 13,
        date: 1,
        chat: { id: 100, type: 'private' },
        from: { id: 200, is_bot: false },
        link_preview_options: { url: 'https://private.example/path' },
      },
    });

    expect((sanitized.message as JsonObject).link_preview_options).toBeUndefined();
  });

  it('transforms outgoing text and button labels in full mode', async () => {
    const filter = new TelegramPrivacyFilter({
      messageContent: {
        mode: 'full',
        transformText: ({ value, field }) => `${field}:${value}`,
      },
    });

    const sanitized = await filter.sanitizeOutgoingPayload({
      chat_id: 100,
      text: 'hello',
      reply_markup: { inline_keyboard: [[{ text: 'Buy', callback_data: 'buy' }]] },
    });

    expect(sanitized?.text).toBe('messageText:hello');
    expect(sanitized?.reply_markup).toEqual({
      inline_keyboard: [[{ text: 'buttonText:Buy', callback_data: 'callbackData:buy' }]],
    });
  });
});
