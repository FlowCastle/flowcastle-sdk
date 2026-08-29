# grammY + FlowCastle example

A complete, runnable [grammY](https://grammy.dev) bot with FlowCastle attached. Copy this folder and you have a
working starting point — the bot stays yours, FlowCastle adds the CRM, goals, Live Chat
and (optionally) no-code flows around it.

What the bot does:

| Command | What happens | FlowCastle call |
| --- | --- | --- |
| `/start` | greets you, shows a demo-goal button | `identify({ displayName })` |
| tap the button | records a goal you can see in Analytics | `goal('demo_goal')` |
| `/qualify` | three inline-keyboard questions, fully in code | `identify(...)` + `goal('lead_qualified')` on completion |
| `/human` | opens the chat in FlowCastle Live Chat for a teammate | `requestLiveAgent(...)` |
| any text | echo (suppressed while a human is active in Live Chat) | — |

After `/qualify` completes, if `FLOWCASTLE_FOLLOW_UP_FLOW_KEY` is set the bot starts a
flow built in the FlowCastle editor (mark that flow **callable from SDK** and give it
that key). Leave it unset to keep everything in code.

## Run it

1. Get a bot token from [@BotFather](https://t.me/BotFather).
2. Get a FlowCastle key: [dashboard](https://dashboard.flowcastle.ai/register) → your
   application → **Add bot → Code SDK** → copy the `fc_sdk_…` key.
3. `cp .env.example .env` and fill both in.
4.
```bash
npm install
npm start
```

Talk to the bot on Telegram — the contact, messages and goals appear in the FlowCastle
dashboard within a few seconds. Stop with Ctrl+C; buffered events are flushed on exit.

Privacy in this example: only `username` and language are shared as contact fields and
message content is routing-only (commands and callback ids, no free text). See the
[privacy contract](../../README.md#privacy-is-configured-in-your-process) to change that.
