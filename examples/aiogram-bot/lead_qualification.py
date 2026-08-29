"""Code-owned three-step lead qualification, framework-neutral."""

from __future__ import annotations

import re
from dataclasses import dataclass, field

STEPS = ('need', 'budget', 'timeline')

QUESTIONS = {
    'need': 'What do you need help with?',
    'budget': 'What budget range fits this project?',
    'timeline': 'When do you want to launch?',
}

OPTIONS: dict[str, list[tuple[str, str]]] = {
    'need': [('Website lead bot', 'website_lead_bot'), ('Telegram automation', 'telegram_automation'), ('Support bot', 'support_bot')],
    'budget': [('Under $500', 'under_500'), ('$500–$2k', '500_2k'), ('$2k+', '2k_plus')],
    'timeline': [('This week', 'this_week'), ('This month', 'this_month'), ('Just researching', 'just_researching')],
}

_CALLBACK = re.compile(r'^lead:(need|budget|timeline):([a-z0-9_]+)$')


@dataclass
class QualificationState:
    answers: dict[str, str] = field(default_factory=dict)

    def next_step(self) -> str | None:
        for step in STEPS:
            if step not in self.answers:
                return step
        return None

    def save(self, step: str, value: str) -> bool:
        if self.next_step() != step or value not in {v for _, v in OPTIONS[step]}:
            return False
        self.answers[step] = value
        return True

    def completed(self) -> dict[str, str] | None:
        if self.next_step() is not None:
            return None
        return {'leadNeed': self.answers['need'], 'leadBudget': self.answers['budget'], 'leadTimeline': self.answers['timeline']}


def parse_callback(data: str) -> tuple[str, str] | None:
    match = _CALLBACK.match(data)
    return (match.group(1), match.group(2)) if match else None


def label(step: str, value: str) -> str:
    return next((text for text, v in OPTIONS[step] if v == value), value)


class InMemoryStore:
    def __init__(self) -> None:
        self._states: dict[int, QualificationState] = {}

    def start(self, user_id: int) -> QualificationState:
        state = QualificationState()
        self._states[user_id] = state
        return state

    def get(self, user_id: int) -> QualificationState | None:
        return self._states.get(user_id)

    def delete(self, user_id: int) -> None:
        self._states.pop(user_id, None)
