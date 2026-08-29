"""A small, realistic aiogram 3 bot with FlowCastle attached.

Everything below /start is ordinary aiogram code. FlowCastle is installed once with
`adapter.install(dp)` and then used from handlers through the `flowcastle` argument
(injected via middleware data) — identify a contact, record goals, hand a chat to a
human, or start a flow that teammates built visually in the FlowCastle editor.
"""

from __future__ import annotations

import asyncio
import logging
import os
import sys

from aiogram import Bot, Dispatcher, F
from aiogram.filters import Command, CommandStart
from aiogram.types import CallbackQuery, InlineKeyboardButton, InlineKeyboardMarkup, Message
from dotenv import load_dotenv
from flowcastle import FlowCastleContext, FlowCastleCore, FlowCastleOptions, PrivacyOptions
from flowcastle.adapters.aiogram import AiogramAdapter

from lead_qualification import OPTIONS, QUESTIONS, InMemoryStore, label, parse_callback

load_dotenv()
logging.basicConfig(level=logging.INFO)


def require_env(name: str) -> str:
    value = os.environ.get(name)
    if not value:
        sys.exit(f'Missing required environment variable {name}.')
    return value


BOT_TOKEN = require_env('BOT_TOKEN')
FLOWCASTLE_API_KEY = require_env('FLOWCASTLE_API_KEY')
FOLLOW_UP_FLOW_KEY = os.environ.get('FLOWCASTLE_FOLLOW_UP_FLOW_KEY')

core = FlowCastleCore(FlowCastleOptions(
    api_key=FLOWCASTLE_API_KEY,
    # Routing-only content: commands and callback ids are shared, free text is not.
    # Use message_content='full' if your FlowCastle flows need message text.
    privacy=PrivacyOptions(contact_fields=('username', 'language_code')),
    # Lets flows built in the FlowCastle editor run through this bot process.
    runtime_enabled=True,
))
adapter = AiogramAdapter(core)

dp = Dispatcher()
qualification = InMemoryStore()


def keyboard_for(step: str) -> InlineKeyboardMarkup:
    return InlineKeyboardMarkup(inline_keyboard=[
        [InlineKeyboardButton(text=text, callback_data=f'lead:{step}:{value}')] for text, value in OPTIONS[step]
    ])


@dp.message(CommandStart())
async def start(message: Message, flowcastle: FlowCastleContext) -> None:
    user = message.from_user
    display_name = ' '.join(filter(None, [user.first_name, user.last_name])) if user else None
    await flowcastle.identify({'displayName': display_name})
    await message.answer(
        f'Welcome, {user.first_name if user else "there"}! This is the FlowCastle aiogram example.\n\n'
        'Send any text and I will echo it back, or tap the button to record a demo goal.',
        reply_markup=InlineKeyboardMarkup(inline_keyboard=[[InlineKeyboardButton(text='🎯 Record demo goal', callback_data='demo_goal')]]),
    )


@dp.message(Command('help'))
async def help_command(message: Message) -> None:
    await message.answer(
        '/start — greet you and identify you as a FlowCastle contact\n'
        '/qualify — three-step lead qualification, fully in code\n'
        '/human — hand this chat to a person in FlowCastle Live Chat\n'
        '/help — this message'
    )


@dp.message(Command('qualify'))
async def qualify(message: Message) -> None:
    if message.from_user is None:
        return
    qualification.start(message.from_user.id)
    await message.answer(QUESTIONS['need'], reply_markup=keyboard_for('need'))


@dp.message(Command('human'))
async def human(message: Message, flowcastle: FlowCastleContext) -> None:
    await flowcastle.request_live_agent('User asked to talk to a human.')
    await message.answer('Connecting you with a teammate — they will reply right here. 💬')


@dp.callback_query(F.data == 'demo_goal')
async def demo_goal(query: CallbackQuery, flowcastle: FlowCastleContext) -> None:
    await flowcastle.goal('demo_goal', {'source': 'example'})
    await query.answer('Goal recorded!')
    if isinstance(query.message, Message):
        await query.message.answer('Recorded a demo_goal — check Analytics in your FlowCastle dashboard.')


@dp.callback_query(F.data.startswith('lead:'))
async def qualification_answer(query: CallbackQuery, flowcastle: FlowCastleContext) -> None:
    parsed = parse_callback(query.data or '')
    state = qualification.get(query.from_user.id)
    if parsed is None or state is None or not state.save(*parsed):
        await query.answer('This step expired. Send /qualify to restart.')
        return
    await query.answer('Saved')
    if not isinstance(query.message, Message):
        return

    next_step = state.next_step()
    if next_step is not None:
        await query.message.answer(QUESTIONS[next_step], reply_markup=keyboard_for(next_step))
        return

    lead = state.completed()
    if lead is None:
        return
    qualification.delete(query.from_user.id)

    # Answers become contact traits (visible in the CRM) and a goal (visible in funnels).
    await flowcastle.identify(lead)
    await flowcastle.goal('lead_qualified', lead)
    await query.message.answer(
        'Thanks — your answers are saved.\n\n'
        f"Need: {label('need', lead['leadNeed'])}\n"
        f"Budget: {label('budget', lead['leadBudget'])}\n"
        f"Timeline: {label('timeline', lead['leadTimeline'])}"
    )

    # Optional: hand off to a follow-up flow that a teammate built in the FlowCastle editor.
    if FOLLOW_UP_FLOW_KEY:
        try:
            await flowcastle.run_flow(FOLLOW_UP_FLOW_KEY, lead)
        except Exception:  # noqa: BLE001 — never let FlowCastle break the bot
            logging.exception('[flowcastle] follow-up flow failed to start')


@dp.message(F.text)
async def echo(message: Message) -> None:
    await message.answer(f'Echo: {message.text}')


async def main() -> None:
    bot = Bot(BOT_TOKEN)
    await adapter.ready()  # load the flow manifest before polling
    adapter.install(dp)
    dp.shutdown.register(adapter.stop)  # final bounded flush on exit
    logging.info('aiogram bot is up with FlowCastle attached.')
    await dp.start_polling(bot)


if __name__ == '__main__':
    asyncio.run(main())
