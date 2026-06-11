#!/usr/bin/env node
/**
 * dietly-autopilot CLI.
 *
 *   node src/cli.ts dry-run [--days N] [--order ID] [--options]   # report only, writes nothing (default)
 *   node src/cli.ts apply   [--days N] [--order ID] [--options]   # actually performs the swaps
 *
 * --options prints, under each slot, the full list of alternatives (marked: chosen / current),
 * so you can skim each day's menu and decide whether to tweak GUIDELINES.md or pick differently.
 */
import { loadConfig } from './config.ts';
import { DietlyClient } from './dietly.ts';
import type { SlotDecision, SlotInput } from './llm.ts';
import { applySwaps, buildPlan, type PlannedDay, type SwapRequest } from './planner.ts';

interface Args {
  mode: 'dry-run' | 'apply';
  days?: number;
  order?: number;
  showOptions?: boolean;
}

function parseArgs(argv: string[]): Args {
  const mode = argv[0] === 'apply' ? 'apply' : 'dry-run';
  const args: Args = { mode };
  for (let i = 1; i < argv.length; i++) {
    if (argv[i] === '--days') args.days = Number(argv[++i]);
    else if (argv[i] === '--order') args.order = Number(argv[++i]);
    else if (argv[i] === '--options' || argv[i] === '--full') args.showOptions = true;
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

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const cfg = loadConfig();
  const horizon = args.days ?? cfg.horizonDays;

  const client = new DietlyClient(cfg.companyId);
  console.log(`Logging in as ${cfg.email} …`);
  await client.login(cfg.email, cfg.password);

  const today = new Date().toLocaleDateString('en-CA');
  const { orders, days, unpublishedByOrder } = await buildPlan(client, cfg, {
    days: horizon,
    order: args.order,
  });

  if (!orders.length) {
    console.log('No active orders found for', cfg.companyId);
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
    console.log(`\n=== Order #${order.orderId} (${order.dietName}, ${order.dietCalories} kcal) ===`);
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
    return;
  }
  if (!pendingSwaps.length) {
    console.log('Nothing to apply.');
    return;
  }

  console.log('Applying …');
  const results = await applySwaps(client, pendingSwaps);
  for (const r of results) {
    console.log(`  ${r.ok ? '✅' : '❌'} ${r.label ?? ''}${r.error ? `: ${r.error}` : ''}`);
  }
  console.log(`Applied ${results.filter((r) => r.ok).length}/${results.length} changes.`);
}

main().catch((e) => {
  console.error('Error:', e instanceof Error ? e.message : e);
  process.exit(1);
});
