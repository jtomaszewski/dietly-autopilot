#!/usr/bin/env node
/**
 * dietly-autopilot CLI.
 *
 *   node src/cli.ts dry-run [--days N] [--order ID] [--options]   # report only, writes nothing (default)
 *   node src/cli.ts apply   [--days N] [--order ID] [--options]   # actually performs the swaps
 *   node src/cli.ts orders                                        # list running orders + their ids
 *   node src/cli.ts replay                                        # how often the model now matches your past overrides
 *
 * --email mails a summary of every published upcoming day's menu to DIETLY_SUMMARY_TO when the run ends,
 * or the error if it fails — meant for the weekly scheduled `apply` (scripts/install-schedule.sh).
 *
 * --options prints, under each slot, the full list of alternatives (marked: chosen / current),
 * so you can skim each day's menu and decide whether to tweak GUIDELINES.md or pick differently.
 */
import { loadConfig } from './config.ts';
import { DietlyClient } from './dietly.ts';
import { extractCorrections, replayCorrections } from './corrections.ts';
import { decideDayLLM, type SlotDecision, type SlotInput } from './llm.ts';
import { logApply, logPlan, readLog } from './log.ts';
import { sendEmail } from './mail.ts';
import {
  applySwaps,
  buildPlan,
  runningOrders,
  todayISO,
  type Plan,
  type PlannedDay,
  type SwapRequest,
  type SwapResult,
} from './planner.ts';
import { renderSummaryEmail, summarizeDays } from './summary.ts';

interface Args {
  mode: 'dry-run' | 'apply' | 'orders' | 'replay';
  days?: number;
  order?: number;
  showOptions?: boolean;
  email?: boolean;
}

function parseArgs(argv: string[]): Args {
  const mode = (['apply', 'orders', 'replay'] as const).find((m) => m === argv[0]) ?? 'dry-run';
  const args: Args = { mode };
  for (let i = 1; i < argv.length; i++) {
    if (argv[i] === '--days') args.days = Number(argv[++i]);
    else if (argv[i] === '--order') args.order = Number(argv[++i]);
    else if (argv[i] === '--options' || argv[i] === '--full') args.showOptions = true;
    else if (argv[i] === '--email') args.email = true;
  }
  return args;
}

const SLOT_ORDER = ['Śniadanie', 'II Śniadanie', 'Obiad', 'Podwieczorek', 'Kolacja'];
const slotRank = (s: string) => {
  const i = SLOT_ORDER.indexOf(s);
  return i < 0 ? 99 : i;
};

const fmtKcal = (k: number | null): string => (k != null ? ` (${k} kcal)` : '');

/** Under a slot, list every alternative, marking the chosen and current dishes. */
function printOptions(slot: SlotInput | undefined, d: SlotDecision): void {
  if (!slot || !slot.editable || !slot.options.length) return;
  for (const o of slot.options) {
    let mark = '·';
    let note = '';
    if (o.dietCaloriesMealId === d.chosenId) {
      mark = '✓';
      note = d.willChange ? '  ← new pick' : '  ← kept';
    } else if (o.dietCaloriesMealId === d.currentId && d.willChange) {
      mark = '✗';
      note = '  ← current (replaced)';
    }
    const variant = o.dietOptionName ? `[${o.dietOptionName}] ` : '';
    console.log(`         ${mark} ${variant}${o.menuMealName}${fmtKcal(o.kcal)}${note}`);
  }
}

function printDay(day: PlannedDay, showOptions: boolean): number {
  const changes = day.decisions.filter((d) => d.willChange);
  const sorted = [...day.decisions].sort((a, b) => slotRank(a.slot) - slotRank(b.slot));
  const slotByName = new Map(day.slots.map((s) => [s.current.mealName, s]));

  if (!day.editable) {
    console.log(`\n  ${day.date}  —  🔒 locked (past edit cutoff)`);
    return 0;
  }

  console.log(`\n  ${day.date}  —  ${changes.length ? `${changes.length} change(s)` : 'no changes'}`);
  for (const d of sorted) {
    if (d.willChange) {
      console.log(`    ✏️  ${d.slot}: ${d.currentDish}`);
      console.log(`        → ${d.chosenDish}   [${d.reason}]`);
    } else {
      const why = showOptions && d.reason && d.reason !== 'keep' ? `   [${d.reason}]` : '';
      console.log(`    ✓  ${d.slot}: ${d.currentDish}${why}`);
    }
    if (showOptions) printOptions(slotByName.get(d.slot), d);
  }
  return changes.length;
}

/** Replay past overrides and report how often the model picks what the user chose. */
async function replay(cfg: ReturnType<typeof loadConfig>): Promise<void> {
  const corrections = extractCorrections(readLog());
  if (!corrections.length) {
    console.log('No manual overrides in the run log yet — nothing to replay.');
    return;
  }
  console.log(`Replaying ${corrections.length} override(s) with ${cfg.model} …\n`);
  const results = await replayCorrections(corrections, cfg.guidelines, (slots, guidelines, date) =>
    decideDayLLM({ slots, guidelines, date, model: cfg.model, apiKey: cfg.openRouterApiKey }),
  );
  const mark = (id: number, userId: number) => (id === userId ? '✓' : '✗');
  for (const { correction: c, baselineId, learnedId } of results) {
    console.log(`  ${mark(baselineId, c.userId)} → ${mark(learnedId, c.userId)}  ${c.date} ${c.slot}: you chose ${c.userName}`);
  }
  const score = (key: 'baselineId' | 'learnedId') => results.filter((r) => r[key] === r.correction.userId).length;
  console.log(`\nMatches your choice — guidelines only: ${score('baselineId')}/${results.length}, with past corrections: ${score('learnedId')}/${results.length}`);
  console.log('(each day is replayed without its own corrections, from names + kcal only)');
}

async function main(args: Args): Promise<void> {
  const cfg = loadConfig();
  if (args.mode === 'replay') return replay(cfg);
  const horizon = args.days ?? cfg.horizonDays;

  const client = new DietlyClient(cfg.companyId);
  console.log(`Logging in as ${cfg.email} …`);
  await client.login(cfg.email, cfg.password);

  // `orders` just lists what's running — handy to grab an id for --order (multiple cateries).
  if (args.mode === 'orders') {
    const running = await runningOrders(client);
    if (!running.length) console.log('No active orders covering today or later.');
    for (const o of running) {
      console.log(`  #${o.orderId}  ${o.companyName}  ${o.dietName}, ${o.dietCalories} kcal  ${o.dateFrom} → ${o.dateTo}`);
    }
    return;
  }

  const today = todayISO();
  const plan = await buildPlan(client, cfg, {
    days: horizon,
    order: args.order,
  });
  const { orders, days, unpublishedByOrder } = plan;
  logPlan(plan, { mode: args.mode, model: cfg.model });

  if (!orders.length) {
    console.log('No active orders covering today or later.');
    return;
  }

  console.log(
    `Mode: ${args.mode.toUpperCase()}  ·  model: ${cfg.model}  ·  from ${today} (${horizon}d)  ·  orders: ${orders
      .map((o) => o.orderId)
      .join(', ')}`,
  );

  const pendingSwaps: SwapRequest[] = [];
  let totalChanges = 0;

  for (const order of orders) {
    console.log(
      `\n=== Order #${order.orderId} — ${order.companyName} (${order.dietName}, ${order.dietCalories} kcal) ===`,
    );
    for (const day of days.filter((d) => d.orderId === order.orderId)) {
      totalChanges += printDay(day, !!args.showOptions);
      for (const d of day.decisions) {
        if (!d.willChange) continue;
        const meal = day.slots.find((s) => s.current.mealName === d.slot)!;
        pendingSwaps.push({
          orderId: order.orderId,
          deliveryId: day.deliveryId,
          deliveryMealId: meal.current.deliveryMealId,
          dietCaloriesMealId: d.chosenId,
          label: `${day.date} ${d.slot} → ${d.chosenDish}`,
          date: day.date,
          slot: d.slot,
          suggestedId: d.chosenId, // CLI applies the model's pick, so suggested == applied
        });
      }
    }
    const unpublished = unpublishedByOrder.get(order.orderId) ?? 0;
    if (unpublished) {
      console.log(`\n  (+${unpublished} day(s) ahead whose menu isn't published yet — skipped)`);
    }
  }

  console.log(`\n${'─'.repeat(60)}`);
  console.log(`Total proposed changes: ${totalChanges}`);

  if (args.mode === 'dry-run') {
    console.log('DRY RUN — nothing was written. Re-run with `apply` to make these changes.');
  } else if (!pendingSwaps.length) {
    console.log('Nothing to apply.');
  }
  const { results, after } =
    args.mode === 'apply' && pendingSwaps.length
      ? await applyAndConfirm(client, cfg, args, horizon, pendingSwaps)
      : { results: args.mode === 'apply' ? [] : null, after: null };

  if (args.email) {
    const unpublished = [...unpublishedByOrder.values()].reduce((a, b) => a + b, 0);
    const email = renderSummaryEmail(summarizeDays(plan, results, after), args.mode, unpublished);
    await sendEmail(cfg.summaryTo, email.subject, email.html);
    console.log(`Emailed the menu summary to ${cfg.summaryTo}.`);
  }
}

/** Apply the swaps, then re-fetch the resulting menu (no LLM) so the log confirms they stuck. */
async function applyAndConfirm(
  client: DietlyClient,
  cfg: ReturnType<typeof loadConfig>,
  args: Args,
  horizon: number,
  pendingSwaps: SwapRequest[],
): Promise<{ results: SwapResult[]; after: Plan | null }> {
  console.log('Applying …');
  const results = await applySwaps(client, pendingSwaps);
  logApply(results, { mode: args.mode });
  for (const r of results) {
    console.log(`  ${r.ok ? '✅' : '❌'} ${r.label ?? ''}${r.error ? `: ${r.error}` : ''}`);
  }
  console.log(`Applied ${results.filter((r) => r.ok).length}/${results.length} changes.`);

  if (!results.some((r) => r.ok)) return { results, after: null };
  try {
    const after = await buildPlan(client, cfg, { days: horizon, order: args.order, decide: false });
    logPlan(after, { mode: 'post-apply', model: cfg.model });
    console.log('Recorded a post-apply snapshot of the resulting menu.');
    return { results, after };
  } catch (e) {
    console.warn(`  ⚠️  could not record post-apply snapshot (${(e as Error).message})`);
    return { results, after: null };
  }
}

const args = parseArgs(process.argv.slice(2));
main(args).catch(async (e) => {
  const message = e instanceof Error ? e.message : String(e);
  console.error('Error:', message);
  if (args.email) {
    // A silent failure would leave the week unpicked unnoticed — say so in the inbox instead.
    try {
      const to = process.env.DIETLY_SUMMARY_TO ?? process.env.DIETLY_EMAIL;
      if (to) await sendEmail(to, '⚠️ dietly-autopilot run failed', `<p>The ${args.mode} run failed:</p><pre>${message.replace(/</g, '&lt;')}</pre>`);
    } catch (mailErr) {
      console.error('Could not email the failure:', (mailErr as Error).message);
    }
  }
  process.exit(1);
});
