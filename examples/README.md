# Examples

Complete, runnable bots — one per supported framework — that all implement the same
small product: `/start` identifies the contact, a button records a goal, `/qualify`
runs a code-owned three-step lead qualification, `/human` hands the chat to a person in
Live Chat, and an optional FlowCastle-authored follow-up flow starts when qualification
completes. Copy the folder for your framework and replace the handlers with yours.

| Folder | Framework | Runtime |
| --- | --- | --- |
| [`grammy-bot`](grammy-bot) | grammY | Node.js 18+ |
| [`telegraf-bot`](telegraf-bot) | Telegraf 4 | Node.js 18+ |
| [`aiogram-bot`](aiogram-bot) | aiogram 3 | Python 3.10+ |
| [`python-telegram-bot-bot`](python-telegram-bot-bot) | python-telegram-bot 21/22 | Python 3.10+ |

Each example depends on the **published** packages (`@flowcastle/grammy`,
`@flowcastle/telegraf`, `flowcastle` on PyPI), so a folder works standalone outside this
repository. Each needs two environment variables — see the `.env.example` in the folder.
