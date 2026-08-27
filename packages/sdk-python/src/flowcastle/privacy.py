"""Fail-closed Telegram payload privacy filtering."""

from __future__ import annotations

import asyncio
import copy
import inspect
import re
from dataclasses import dataclass
from typing import Awaitable, Callable, Literal, Mapping, TypedDict, cast

from .types import JsonObject

ContentMode = Literal['full', 'routing', 'none']
CONTACT_FIELDS = ('username', 'first_name', 'last_name', 'language_code', 'is_premium', 'added_to_attachment_menu')
CONTENT_FIELDS = {
    'address', 'caption', 'caption_entities', 'contact', 'document', 'email', 'entities',
    'file_name', 'location', 'phone_number', 'photo', 'poll', 'text', 'venue', 'video',
    'voice', 'vcard', 'query', 'data', 'callback_data',
}
OPERATIONAL_FIELDS = {
    'actor_chat', 'business_connection_id', 'callback_query', 'chat', 'chat_instance', 'date',
    'edit_date', 'from', 'id', 'is_bot', 'is_member', 'message', 'new_chat_member',
    'old_chat_member', 'reply_to_message', 'sender_chat', 'status', 'type', 'user', 'via_bot',
}
OUTGOING_OPERATIONAL = {
    'action', 'business_connection_id', 'callback_query_id', 'chat_id', 'from_chat_id',
    'inline_message_id', 'message_id', 'message_thread_id', 'pre_checkout_query_id',
    'sender_chat_id', 'shipping_query_id', 'until_date', 'user_id',
}


class TextTransformContext(TypedDict):
    value: str
    field: str
    update_type: str


TextTransformer = Callable[[TextTransformContext], str | None | Awaitable[str | None]]


@dataclass(frozen=True)
class PrivacyOptions:
    contact_fields: tuple[str, ...] | None = None
    message_content: ContentMode = 'routing'
    transform_text: TextTransformer | None = None
    transform_timeout_ms: int = 1000


class PrivacyFilter:
    def __init__(self, options: PrivacyOptions | Mapping[str, object] | None, on_error: Callable[[Exception], None]) -> None:
        self._options = self._normalize(options)
        self._on_error = on_error
        # Compatibility: no policy requested retains previous complete payload behavior.
        self._mode: ContentMode = 'full' if options is None else self._options.message_content
        self._contacts = set(CONTACT_FIELDS if options is None else self._options.contact_fields or ())

    def _normalize(self, options: PrivacyOptions | Mapping[str, object] | None) -> PrivacyOptions:
        if options is None:
            return PrivacyOptions(tuple(CONTACT_FIELDS), 'full')
        if isinstance(options, PrivacyOptions):
            return options
        raw_contacts = options.get('contact_fields')
        contacts = tuple(value for value in raw_contacts if isinstance(value, str)) if isinstance(raw_contacts, (list, tuple)) else ()
        raw_mode = options.get('message_content', 'routing')
        mode: ContentMode = raw_mode if raw_mode in {'full', 'routing', 'none'} else 'routing'
        transformer = options.get('transform_text')
        timeout = options.get('transform_timeout_ms', 1000)
        return PrivacyOptions(
            contacts,
            mode,
            cast(TextTransformer | None, transformer if callable(transformer) else None),
            timeout if isinstance(timeout, int) else 1000,
        )

    async def sanitize_update(self, update: JsonObject) -> JsonObject:
        clone = copy.deepcopy(update)
        if self._mode != 'full':
            clone = self._restrict_incoming(clone)
        await self._sanitize_recursive(clone, self._update_type(clone), ())
        return clone

    async def sanitize_outgoing(self, payload: JsonObject) -> JsonObject:
        clone = copy.deepcopy(payload)
        if self._mode != 'full':
            clone = {key: value for key, value in clone.items() if key in OUTGOING_OPERATIONAL}
            if self._mode == 'routing' and isinstance(payload.get('reply_markup'), dict):
                clone['reply_markup'] = self._slim_keyboard(payload['reply_markup'])
        await self._sanitize_recursive(clone, 'outgoing', ())
        return clone

    def _restrict_incoming(self, update: JsonObject) -> JsonObject:
        result: JsonObject = {}
        if isinstance(update.get('update_id'), (str, int)):
            result['update_id'] = update['update_id']
        for key, value in update.items():
            if key != 'update_id' and isinstance(value, dict):
                result[key] = self._restrict_object(value)
        return result

    def _restrict_object(self, value: JsonObject) -> JsonObject:
        result: JsonObject = {}
        for key, candidate in value.items():
            route_content = self._mode == 'routing' and key in {'text', 'data', 'callback_data'}
            allowed = key in OPERATIONAL_FIELDS or key in self._contacts or key.endswith('_id') or key.endswith('_date') or route_content
            if not allowed:
                continue
            if isinstance(candidate, dict):
                result[key] = self._restrict_object(candidate)
            elif isinstance(candidate, list):
                if key == 'message_ids':
                    result[key] = candidate
            else:
                result[key] = candidate
        return result

    async def _sanitize_recursive(self, value: JsonObject, update_type: str, path: tuple[str, ...]) -> None:
        for contact in CONTACT_FIELDS:
            if contact not in self._contacts:
                value.pop(contact, None)
        if self._mode == 'none':
            for field in CONTENT_FIELDS | {'reply_markup'}:
                value.pop(field, None)
        elif self._mode == 'routing':
            await self._routing_content(value, update_type, path)
        else:
            await self._full_content(value, update_type, path)
        for key, child in list(value.items()):
            if isinstance(child, dict):
                await self._sanitize_recursive(child, update_type, path + (key,))
            elif isinstance(child, list):
                for entry in child:
                    if isinstance(entry, dict):
                        await self._sanitize_recursive(entry, update_type, path + (key,))

    async def _routing_content(self, value: JsonObject, update_type: str, path: tuple[str, ...]) -> None:
        for field in CONTENT_FIELDS - {'text', 'data', 'callback_data'}:
            value.pop(field, None)
        text = value.get('text')
        if isinstance(text, str):
            command = re.match(r'^(\/[A-Za-z0-9_]+(?:@[A-Za-z0-9_]+)?)(?:\s+.*)?$', text)
            if command is None:
                value.pop('text', None)
            else:
                value['text'] = command.group(1)
                value.pop('entities', None)
        await self._transform_callback(value, update_type, path)

    async def _full_content(self, value: JsonObject, update_type: str, path: tuple[str, ...]) -> None:
        for key, field in (('text', 'message_text'), ('caption', 'caption'), ('vcard', 'contact_vcard')):
            await self._transform_field(value, key, field, update_type)
        await self._transform_callback(value, update_type, path)

    async def _transform_callback(self, value: JsonObject, update_type: str, path: tuple[str, ...]) -> None:
        for key in ('callback_data', 'data'):
            if key == 'data' and (not path or path[-1] != 'callback_query'):
                continue
            await self._transform_field(value, key, 'callback_data', update_type)

    async def _transform_field(self, value: JsonObject, key: str, field: str, update_type: str) -> None:
        original = value.get(key)
        if not isinstance(original, str) or self._options is None or self._options.transform_text is None:
            return
        try:
            transformed = self._options.transform_text({'value': original, 'field': field, 'update_type': update_type})
            if inspect.isawaitable(transformed):
                transformed = await asyncio.wait_for(transformed, self._timeout_seconds())
            if transformed is None:
                value.pop(key, None)
            elif isinstance(transformed, str):
                value[key] = transformed
            else:
                raise TypeError('transform_text must return str or None')
        except Exception as error:
            value.pop(key, None)
            self._report(error)

    def _timeout_seconds(self) -> float:
        assert self._options is not None
        return max(1, self._options.transform_timeout_ms) / 1000

    def _update_type(self, update: JsonObject) -> str:
        return next((key for key in update if key != 'update_id'), 'unknown')

    def _slim_keyboard(self, value: object) -> JsonObject:
        if not isinstance(value, dict) or not isinstance(value.get('inline_keyboard'), list):
            return {}
        rows: list[list[JsonObject]] = []
        for row in value['inline_keyboard']:
            if not isinstance(row, list):
                continue
            buttons = [{key: item[key] for key in ('text', 'callback_data', 'url') if isinstance(item, dict) and key in item} for item in row]
            rows.append(buttons)
        return {'inline_keyboard': rows}

    def _report(self, error: Exception) -> None:
        try:
            self._on_error(error)
        except Exception:
            pass
