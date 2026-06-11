/**
 * Shared planning logic used by both the CLI and the web server: log in, gather the upcoming
 * editable days, ask the model to decide each day, and (separately) apply chosen swaps.
 */
import type { Config } from './config.ts';
import { type Delivery, type DietlyClient, type MenuMeal, type OrderSummary, type SwitchOption, HttpError } from './dietly.ts';
import { decideDayLLM, keepAllDecisions, type SlotDecision, type SlotInput } from './llm.ts';

export function todayISO(): string {
  // Local date (the catering operates in Europe/Warsaw; running locally there is assumed).
  return new Date().toLocaleDateString('en-CA'); // YYYY-MM-DD
}

export function addDays(iso: string, n: number): string {
  const d = new Date(`${iso}T00:00:00`);
  d.setDate(d.getDate() + n);
  return d.toLocaleDateString('en-CA');
}

/** A day's menu is "published" once at least one slot has a real dish name (not just the slot label). */
export function isPublished(slots: SlotInput[]): boolean {
  return slots.some(
    (s) => s.current.menuMealName && s.current.menuMealName.toLowerCase() !== s.current.mealName.toLowerCase(),
  );
}

/** Fetch every slot's current meal + switch options for one delivery day. */
export async function gatherDay(
  client: DietlyClient,
  orderId: number,
  delivery: Delivery,
): Promise<SlotInput[]> {
  let menu: MenuMeal[];
  try {
    menu = await client.getDayMenu(delivery.deliveryId);
  } catch {
    return [];
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

export interface PlannedDay {
  orderId: number;
  date: string;
  deliveryId: number;
  editable: boolean;
  slots: SlotInput[];
  decisions: SlotDecision[];
}

export interface Plan {
  orders: OrderSummary[];
  days: PlannedDay[]; // published days only (locked + editable); excludes not-yet-published
  unpublishedByOrder: Map<number, number>;
}

/** Build the full plan: which days/slots, and the model's keep/change decision per slot. */
export async function buildPlan(
  client: DietlyClient,
  cfg: Pick<Config, 'companyId' | 'guidelines' | 'model' | 'openRouterApiKey'>,
  opts: { days: number; order?: number },
): Promise<Plan> {
  const today = todayISO();
  const until = addDays(today, opts.days);

  const orders = (await client.getActiveOrders()).filter(
    (o) => o.companyName === cfg.companyId && o.dateTo >= today && (!opts.order || o.orderId === opts.order),
  );

  const days: PlannedDay[] = [];
  const unpublishedByOrder = new Map<number, number>();

  for (const order of orders) {
    const { deliveries } = await client.getOrder(order.orderId);
    const upcoming = (deliveries ?? [])
      .filter((d) => !d.deleted && d.date >= today && d.date <= until)
      .sort((a, b) => a.date.localeCompare(b.date));

    let unpublished = 0;
    for (const delivery of upcoming) {
      const slots = await gatherDay(client, order.orderId, delivery);
      if (!slots.length || !isPublished(slots)) {
        unpublished++;
        continue;
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
      days.push({ orderId: order.orderId, date: delivery.date, deliveryId: delivery.deliveryId, editable, slots, decisions });
    }
    unpublishedByOrder.set(order.orderId, unpublished);
  }

  return { orders, days, unpublishedByOrder };
}

export interface SwapRequest {
  orderId: number;
  deliveryId: number;
  deliveryMealId: number;
  dietCaloriesMealId: number;
  label?: string;
}

export interface SwapResult extends SwapRequest {
  ok: boolean;
  error?: string;
}

/** Apply a set of swaps sequentially, collecting per-swap results (never throws). */
export async function applySwaps(client: DietlyClient, swaps: SwapRequest[]): Promise<SwapResult[]> {
  const results: SwapResult[] = [];
  for (const s of swaps) {
    try {
      await client.swapMeal(s.orderId, s.deliveryId, s.deliveryMealId, s.dietCaloriesMealId);
      results.push({ ...s, ok: true });
    } catch (e) {
      results.push({ ...s, ok: false, error: (e as Error).message });
    }
  }
  return results;
}
