"""A small, realistic python-telegram-bot (v21/22) bot with FlowCastle attached.

Everything below /start is ordinary PTB code. FlowCastle is installed once with
`adapter.install(application)` and then used from handlers via `context.flowcastle` —
identify a contact, record goals, hand a chat to a human, or start a flow that
teammates built visually in the FlowCastle editor.
"""

from __future__ import annotations

import logging
import os
import sys

from dotenv import load_dotenv
from flowcastle import FlowCastleContext, FlowCastleCore, FlowCastleOptions, PrivacyOptions
from flowcastle.adapters.python_telegram_bot import PythonTelegramBotAdapter
from telegram import InlineKeyboardButton, InlineKeyboardMarkup, Update
from telegram.ext import Application, CallbackQueryHandler, CommandHandler, ContextTypes, MessageHandler, filters

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
    privacy=PrivacyOptions(contact_fields=('username', 'language_code')),
    # Lets flows built in the FlowCastle editor run through this bot process.
    runtime_enabled=True,
))
adapter = PythonTelegramBotAdapter(core)
qualification = InMemoryStore()


def fc(context: ContextTypes.DEFAULT_TYPE) -> FlowCastleContext:
    """The FlowCastle context the adapter attaches to every unmatched update."""
    return getattr(context, 'flowcastle')


def keyboard_for(step: str) -> InlineKeyboardMarkup:
    return InlineKeyboardMarkup([[InlineKeyboardButton(text, callback_data=f'lead:{step}:{value}')] for text, value in OPTIONS[step]])


async def start(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
    user = update.effective_user
    if update.message is None or user is None:
        return
    await fc(context).identify({'displayName': user.full_name})
    await update.message.reply_text(
        f'Welcome, {user.first_name}! This is the FlowCastle python-telegram-bot example.\n\n'
        'Send any text and I will echo it back, or tap the button to record a demo goal.',
        reply_markup=InlineKeyboardMarkup([[InlineKeyboardButton('🎯 Record demo goal', callback_data='demo_goal')]]),
    )


async def help_command(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
    if update.message is None:
        return
    await update.message.reply_text(
        '/start — greet you and identify you as a FlowCastle contact\n'
        '/qualify — three-step lead qualification, fully in code\n'
        '/human — hand this chat to a person in FlowCastle Live Chat\n'
        '/help — this message'
    )


async def qualify(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
    if update.message is None or update.effective_user is None:
        return
    qualification.start(update.effective_user.id)
    await update.message.reply_text(QUESTIONS['need'], reply_markup=keyboard_for('need'))


async def human(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
    if update.message is None:
        return
    await fc(context).request_live_agent('User asked to talk to a human.')
    await update.message.reply_text('Connecting you with a teammate — they will reply right here. 💬')


async def demo_goal(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
    query = update.callback_query
    if query is None:
        return
    await fc(context).goal('demo_goal', {'source': 'example'})
    await query.answer('Goal recorded!')
    if update.effective_chat is not None:
        await context.bot.send_message(update.effective_chat.id, 'Recorded a demo_goal — check Analytics in your FlowCastle dashboard.')


async def qualification_answer(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
    query = update.callback_query
    if query is None or update.effective_user is None or update.effective_chat is None:
        return
    parsed = parse_callback(query.data or '')
    state = qualification.get(update.effective_user.id)
    if parsed is None or state is None or not state.save(*parsed):
        await query.answer('This step expired. Send /qualify to restart.')
        return
    await query.answer('Saved')
    chat_id = update.effective_chat.id

    next_step = state.next_step()
    if next_step is not None:
        await context.bot.send_message(chat_id, QUESTIONS[next_step], reply_markup=keyboard_for(next_step))
        return

    lead = state.completed()
    if lead is None:
        return
    qualification.delete(update.effective_user.id)

    # Answers become contact traits (visible in the CRM) and a goal (visible in funnels).
    await fc(context).identify(lead)
    await fc(context).goal('lead_qualified', lead)
    await context.bot.send_message(
        chat_id,
        'Thanks — your answers are saved.\n\n'
        f"Need: {label('need', lead['leadNeed'])}\n"
        f"Budget: {label('budget', lead['leadBudget'])}\n"
        f"Timeline: {label('timeline', lead['leadTimeline'])}",
    )

    # Optional: hand off to a follow-up flow that a teammate built in the FlowCastle editor.
    if FOLLOW_UP_FLOW_KEY:
        try:
            await fc(context).run_flow(FOLLOW_UP_FLOW_KEY, lead)
        except Exception:  # noqa: BLE001 — never let FlowCastle break the bot
            logging.exception('[flowcastle] follow-up flow failed to start')


async def echo(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
    if update.message is not None and update.message.text is not None:
        await update.message.reply_text(f'Echo: {update.message.text}')


async def on_startup(application: Application) -> None:
    await adapter.ready()  # load the flow manifest before polling


async def on_shutdown(application: Application) -> None:
    await adapter.stop()  # final bounded flush


def main() -> None:
    application = Application.builder().token(BOT_TOKEN).post_init(on_startup).post_shutdown(on_shutdown).build()
    adapter.install(application)  # early handler group; matched updates never reach the handlers below

    application.add_handler(CommandHandler('start', start))
    application.add_handler(CommandHandler('help', help_command))
    application.add_handler(CommandHandler('qualify', qualify))
    application.add_handler(CommandHandler('human', human))
    application.add_handler(CallbackQueryHandler(demo_goal, pattern='^demo_goal$'))
    application.add_handler(CallbackQueryHandler(qualification_answer, pattern='^lead:'))
    application.add_handler(MessageHandler(filters.TEXT & ~filters.COMMAND, echo))

    logging.info('python-telegram-bot is up with FlowCastle attached.')
    application.run_polling()


if __name__ == '__main__':
    main()
