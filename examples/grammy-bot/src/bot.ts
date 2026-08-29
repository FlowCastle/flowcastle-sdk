/**
 * A small, realistic grammY bot with FlowCastle attached.
 *
 * Everything below /start is ordinary grammY code you already know how to write.
 * FlowCastle is installed once with `bot.use(fc)` and then used from handlers via
 * `ctx.flowcastle` — identify a contact, record goals, hand a chat to a human, or
 * start a flow that teammates built visually in the FlowCastle editor.
 */
import { Bot, Context, InlineKeyboard } from 'grammy';
import { flowcastle, FlowCastleFlavor } from '@flowcastle/grammy';

import {
  completedQualification,
  InMemoryLeadQualificationStore,
  nextQualificationStep,
  parseQualificationCallback,
  QUALIFICATION_OPTIONS,
  QUALIFICATION_QUESTIONS,
  qualificationLabel,
  saveQualificationAnswer,
  type QualificationStep,
} from './lead-qualification';

type BotContext = FlowCastleFlavor<Context>;

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    console.error(`Missing required environment variable ${name}.`);
    process.exit(1);
  }
  return value;
}

const BOT_TOKEN = requireEnv('BOT_TOKEN');
const FLOWCASTLE_API_KEY = requireEnv('FLOWCASTLE_API_KEY');
const FOLLOW_UP_FLOW_KEY = process.env.FLOWCASTLE_FOLLOW_UP_FLOW_KEY;

const bot = new Bot<BotContext>(BOT_TOKEN);

// Install FlowCastle FIRST so it observes every update and outgoing call.
const fc = flowcastle<BotContext>({
  apiKey: FLOWCASTLE_API_KEY,
  // Routing-only content: commands and callback ids are shared, free text is not.
  // Switch to `{ messageContent: 'full' }` if your FlowCastle flows need message text.
  privacy: { contactFields: ['username', 'languageCode'] },
  // Lets flows built in the FlowCastle editor run through this bot process.
  runtime: { enabled: true },
  onError: (error) => console.error('[flowcastle]', error),
});
bot.use(fc);

const qualification = new InMemoryLeadQualificationStore();

const keyboardFor = (step: QualificationStep): InlineKeyboard => {
  const keyboard = new InlineKeyboard();
  for (const option of QUALIFICATION_OPTIONS[step]) keyboard.text(option.label, `lead:${step}:${option.value}`).row();
  return keyboard;
};

bot.command('start', async (ctx) => {
  const displayName = [ctx.from?.first_name, ctx.from?.last_name].filter(Boolean).join(' ') || ctx.from?.username;
  ctx.flowcastle.identify({ displayName });
  await ctx.reply(
    `Welcome${ctx.from?.first_name ? `, ${ctx.from.first_name}` : ''}! This is the FlowCastle grammY example.\n\n` +
      'Send any text and I will echo it back, or tap the button to record a demo goal.',
    { reply_markup: new InlineKeyboard().text('🎯 Record demo goal', 'demo_goal') },
  );
});

bot.command('help', (ctx) =>
  ctx.reply(
    '/start — greet you and identify you as a FlowCastle contact\n' +
      '/qualify — three-step lead qualification, fully in code\n' +
      '/human — hand this chat to a person in FlowCastle Live Chat\n' +
      '/help — this message',
  ),
);

bot.command('qualify', async (ctx) => {
  if (ctx.from === undefined) return;
  qualification.set(ctx.from.id, {});
  await ctx.reply(QUALIFICATION_QUESTIONS.need, { reply_markup: keyboardFor('need') });
});

bot.command('human', async (ctx) => {
  ctx.flowcastle.requestLiveAgent({ note: 'User asked to talk to a human.' });
  await ctx.reply('Connecting you with a teammate — they will reply right here. 💬');
});

bot.on('callback_query:data', async (ctx) => {
  if (ctx.callbackQuery.data === 'demo_goal') {
    ctx.flowcastle.goal('demo_goal', { source: 'example' });
    await ctx.answerCallbackQuery({ text: 'Goal recorded!' });
    await ctx.reply('Recorded a demo_goal — check Analytics in your FlowCastle dashboard.');
    return;
  }

  const answer = parseQualificationCallback(ctx.callbackQuery.data);
  if (answer === undefined) return ctx.answerCallbackQuery();

  const current = qualification.get(ctx.from.id);
  const updated = current === undefined ? undefined : saveQualificationAnswer(current, answer.step, answer.value);
  if (updated === undefined) return ctx.answerCallbackQuery({ text: 'This step expired. Send /qualify to restart.' });

  qualification.set(ctx.from.id, updated);
  await ctx.answerCallbackQuery({ text: 'Saved' });

  const nextStep = nextQualificationStep(updated);
  if (nextStep !== undefined) return ctx.reply(QUALIFICATION_QUESTIONS[nextStep], { reply_markup: keyboardFor(nextStep) });

  const result = completedQualification(updated);
  if (result === undefined) return;
  const lead = { leadNeed: result.need, leadBudget: result.budget, leadTimeline: result.timeline };
  qualification.delete(ctx.from.id);

  // Answers become contact traits (visible in the CRM) and a goal (visible in funnels).
  ctx.flowcastle.identify(lead);
  ctx.flowcastle.goal('lead_qualified', lead);
  await ctx.reply(
    'Thanks — your answers are saved.\n\n' +
      `Need: ${qualificationLabel('need', lead.leadNeed)}\n` +
      `Budget: ${qualificationLabel('budget', lead.leadBudget)}\n` +
      `Timeline: ${qualificationLabel('timeline', lead.leadTimeline)}`,
  );

  // Optional: hand off to a follow-up flow that a teammate built in the FlowCastle editor.
  if (FOLLOW_UP_FLOW_KEY !== undefined) {
    try {
      await ctx.flowcastle.runFlow(FOLLOW_UP_FLOW_KEY, { inputs: lead });
    } catch (error) {
      console.error('[flowcastle] follow-up flow failed to start', error);
    }
  }
});

bot.on('message:text', async (ctx) => {
  // A human is handling this chat in Live Chat — do not echo over them.
  if (ctx.flowcastle.isLiveAgentActive) return;
  await ctx.reply(`Echo: ${ctx.message.text}`);
});

async function shutdown(signal: NodeJS.Signals): Promise<void> {
  console.log(`\n${signal}: shutting down`);
  await bot.stop();
  await fc.flush(); // ship anything still buffered
  fc.destroy();
  process.exit(0);
}
process.once('SIGINT', () => void shutdown('SIGINT'));
process.once('SIGTERM', () => void shutdown('SIGTERM'));

async function main(): Promise<void> {
  await fc.ready(); // load the flow manifest before polling so the first matching update is routed correctly
  await bot.start({ onStart: (me) => console.log(`@${me.username} is up with FlowCastle attached.`) });
}
void main().catch((error: unknown) => {
  console.error('Failed to start:', error);
  fc.destroy();
  process.exitCode = 1;
});
