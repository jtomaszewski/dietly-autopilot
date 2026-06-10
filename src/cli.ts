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
import { DietlyClient, HttpError, type Delivery, type MenuMeal, type SwitchOption } from './dietly.ts';
import { decideDayLLM, keepAllDecisions, type SlotDecision, type SlotInput } from './llm.ts';

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

function todayISO(): string {
  // Local date (the catering operates in Europe/Warsaw; running locally there is assumed).
  return new Date().toLocaleDateString('en-CA'); // YYYY-MM-DD
}

function addDays(iso: string, n: number): string {
  const d = new Date(`${iso}T00:00:00`);
  d.setDate(d.getDate() + n);
  return d.toLocaleDateString('en-CA');
}

/** Fetch every slot's current meal + switch options for one delivery day. */
async function gatherDay(
  client: DietlyClient,
  orderId: number,
  delivery: Delivery,
): Promise<SlotInput[]> {
  let menu: MenuMeal[];
  try {
    menu = await client.getDayMenu(delivery.deliveryId);
  } catch {
    return []; // menu not available for this day
  }
  const slots: SlotInput[] = [];
  for (const meal of menu) {
    let options: SwitchOption[] = [];
    let editable = false;
    if (meal.switchable) {
      try {
        options = await client.getSwitchOptions(orderId, delivery.deliveryId, meal.deliveryMealId);
        editable = options.some((o) => o.canBeChanged);
      } catch (e) {
        if (!(e instanceof HttpError)) throw e;
        editable = false; // locked / past cutoff
      }
    }
    slots.push({ current: meal, options, editable });
  }
  return slots;
}

const SLOT_ORDER = ['Śniadanie', 'II Śniadanie', 'Obiad', 'Podwieczorek', 'Kolacja'];
const slotRank = (s: string) => {
  const i = SLOT_ORDER.indexOf(s);
  return i < 0 ? 99 : i;
};

/** A day's menu is "published" once at least one slot has a real dish name (not just the slot label). */
function isPublished(slots: SlotInput[]): boolean {
  return slots.some(
    (s) => s.current.menuMealName && s.current.menuMealName.toLowerCase() !== s.current.mealName.toLowerCase(),
  );
}

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

function printDay(
  date: string,
  slots: SlotInput[],
  decisions: SlotDecision[],
  showOptions: boolean,
): number {
  const changes = decisions.filter((d) => d.willChange);
  const editable = decisions.some((d) => d.editable);
  const sorted = [...decisions].sort((a, b) => slotRank(a.slot) - slotRank(b.slot));
  const slotByName = new Map(slots.map((s) => [s.current.mealName, s]));

  if (!editable) {
    console.log(`\n  ${date}  —  🔒 locked (past edit cutoff)`);
    return 0;
  }

  console.log(`\n  ${date}  —  ${changes.length ? `${changes.length} change(s)` : 'no changes'}`);
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

  const today = todayISO();
  const until = addDays(today, horizon);

  const orders = (await client.getActiveOrders()).filter(
    (o) =>
      o.companyName === cfg.companyId &&
      o.dateTo >= today &&
      (!args.order || o.orderId === args.order),
  );
  if (!orders.length) {
    console.log('No active orders found for', cfg.companyId);
    return;
  }

  console.log(
    `Mode: ${args.mode.toUpperCase()}  ·  model: ${cfg.model}  ·  horizon: ${today} → ${until} (${horizon}d)  ·  orders: ${orders
      .map((o) => o.orderId)
      .join(', ')}`,
  );

  const pendingSwaps: Array<{ orderId: number; deliveryId: number; d: SlotDecision; deliveryMealId: number }> = [];
  let totalChanges = 0;

  for (const order of orders) {
    const { deliveries } = await client.getOrder(order.orderId);
    const upcoming = (deliveries ?? [])
      .filter((d) => !d.deleted && d.date >= today && d.date <= until)
      .sort((a, b) => a.date.localeCompare(b.date));

    console.log(`\n=== Order #${order.orderId} (${order.dietName}, ${order.dietCalories} kcal) ===`);

    let unpublished = 0;
    for (const delivery of upcoming) {
      const slots = await gatherDay(client, order.orderId, delivery);
      if (!slots.length || !isPublished(slots)) {
        unpublished++;
        continue; // menu for this day isn't out yet
      }
      const editable = slots.some((s) => s.editable);
      const decisions = editable
        ? await decideDayLLM({
            slots,
            guidelines: cfg.guidelines,
            model: cfg.model,
            apiKey: cfg.openRouterApiKey,
            date: delivery.date,
          })
        : keepAllDecisions(slots);
      totalChanges += printDay(delivery.date, slots, decisions, !!args.showOptions);
      for (const d of decisions) {
        if (!d.willChange) continue;
        const meal = slots.find((s) => s.current.mealName === d.slot)!;
        pendingSwaps.push({
          orderId: order.orderId,
          deliveryId: delivery.deliveryId,
          d,
          deliveryMealId: meal.current.deliveryMealId,
        });
      }
    }
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
  let ok = 0;
  for (const s of pendingSwaps) {
    try {
      await client.swapMeal(s.orderId, s.deliveryId, s.deliveryMealId, s.d.chosenId);
      console.log(`  ✅ ${s.d.slot} → ${s.d.chosenDish}`);
      ok++;
    } catch (e) {
      console.log(`  ❌ ${s.d.slot} → ${s.d.chosenDish}: ${(e as Error).message}`);
    }
  }
  console.log(`Applied ${ok}/${pendingSwaps.length} changes.`);
}

main().catch((e) => {
  console.error('Error:', e instanceof Error ? e.message : e);
  process.exit(1);
});
