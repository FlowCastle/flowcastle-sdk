"""Optional framework adapters. Importing these modules never imports Telegram SDKs."""

from .aiogram import AiogramAdapter
from .python_telegram_bot import PythonTelegramBotAdapter

__all__ = ['AiogramAdapter', 'PythonTelegramBotAdapter']
