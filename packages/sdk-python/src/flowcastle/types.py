"""JSON-safe protocol-v2 value objects."""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Literal, Mapping, TypeAlias

JsonValue: TypeAlias = Any
JsonObject: TypeAlias = dict[str, JsonValue]
ChatType: TypeAlias = Literal['private', 'group', 'supergroup', 'channel']


@dataclass(frozen=True)
class RuntimeRule:
    id: str
    flow_id: str
    kind: Literal['command', 'message', 'deep_link', 'callback', 'event']
    chat_types: tuple[ChatType, ...] | None = None
    visibility: Literal['all', 'addressed'] | None = None
    command: str | None = None
    text: Mapping[str, JsonValue] | None = None
    callback_data: Mapping[str, JsonValue] | None = None
    event_type: str | None = None
    claim_scope: Literal['chat', 'chat_actor'] | None = None
    priority: float | None = None


@dataclass(frozen=True)
class RuntimeManifest:
    protocol_version: int
    version: str
    rules: tuple[RuntimeRule, ...]
    required_capabilities: tuple[str, ...] = ()


@dataclass(frozen=True)
class ConversationClaim:
    conversation_key: str
    generation: float
    kinds: tuple[str, ...]
    expires_at: float


@dataclass(frozen=True)
class RuntimeUpdate:
    raw: JsonObject
    update_id: int | str | None = None
    chat_id: int | str | None = None
    actor_id: int | str | None = None
    chat_type: ChatType | None = None
    text: str | None = None
    command: str | None = None
    command_payload: str | None = None
    callback_data: str | None = None
    event_type: str | None = None
    addressed: bool = False


@dataclass(frozen=True)
class RuntimeJob:
    id: str
    kind: Literal['transport_call', 'control']
    params: JsonObject
    protocol_version: int = 2
    lease_token: str | None = None
    operation: str | None = None
    transport: str = 'telegram'
    chat_key: str | None = None


@dataclass(frozen=True)
class JobAck:
    id: str
    ok: bool
    lease_token: str | None = None
    result: JsonValue | None = None
    error: dict[str, JsonValue] | None = None


def object_value(value: Any) -> JsonObject | None:
    """Return a recursively JSON-safe object, rejecting arbitrary Python values."""
    if not isinstance(value, dict):
        return None
    copied: dict[str, JsonValue] = {}
    for key, entry in value.items():
        if not isinstance(key, str):
            return None
        json_entry = json_value(entry)
        if json_entry is _INVALID:
            return None
        copied[key] = json_entry
    return copied


_INVALID = object()


def json_value(value: Any) -> JsonValue | object:
    if value is None or isinstance(value, (bool, int, float, str)):
        return value
    if isinstance(value, list):
        result: list[JsonValue] = []
        for item in value:
            json_item = json_value(item)
            if json_item is _INVALID:
                return _INVALID
            result.append(json_item)
        return result
    if isinstance(value, dict):
        object_result = object_value(value)
        return _INVALID if object_result is None else object_result
    return _INVALID
