/**
 * Manual overrides as an eval set. Whenever the user applied something other than the model's
 * pick, the run log holds a correction: what was on the plate, what the model chose, what the
 * user chose instead. `replay` re-asks the model about those days to measure how often it agrees
 * with the user — with the guidelines alone, and with the other corrections as examples.
 */
import type { MenuMeal, SwitchOption } from './dietly.ts';
import type { SlotInput } from './llm.ts';
import type { LoggedDay, LogRecord, PlanRecord } from './log.ts';

export interface Correction {
  orderId: number;
  date: string;
  slot: string;
  currentName: string;
  modelName: string;
  userId: number;
  userName: string;
  /** the logged day the model decided on — what replay re-asks the model about */
  day: LoggedDay;
}

/** The last model-decided snapshot of a day taken before `ts` (post-apply snapshots carry no decision). */
function decidedDayBefore(plans: PlanRecord[], ts: string, orderId: number, date: string): LoggedDay | undefined {
  for (let i = plans.length - 1; i >= 0; i--) {
    const p = plans[i]!;
    if (p.ts > ts || p.mode === 'post-apply') continue;
    const day = p.days.find((d) => d.orderId === orderId && d.date === date);
    if (day) return day;
  }
  return undefined;
}

/** Every override in the log, oldest first; a slot overridden twice keeps only the latest. */
export function extractCorrections(records: LogRecord[]): Correction[] {
  const plans = records.filter((r): r is PlanRecord => r.kind === 'plan');
  const bySlot = new Map<string, Correction>();
  for (const rec of records) {
    if (rec.kind !== 'apply') continue;
    for (const r of rec.results) {
      if (!r.ok || r.suggestedId == null || r.suggestedId === r.chosenId || !r.date || !r.slot) continue;
      const day = decidedDayBefore(plans, rec.ts, r.orderId, r.date);
      const slot = day?.slots.find((s) => s.slot === r.slot);
      const user = slot?.options.find((o) => o.id === r.chosenId);
      if (!day || !slot || !user) continue;
      const key = `${r.orderId}|${r.date}|${r.slot}`;
      bySlot.delete(key);
      bySlot.set(key, {
        orderId: r.orderId,
        date: r.date,
        slot: r.slot,
        currentName: slot.currentName,
        modelName: slot.suggestedName,
        userId: user.id,
        userName: user.name,
        day,
      });
    }
  }
  return [...bySlot.values()];
}

/** System-prompt section listing the most recent corrections; empty when there are none. */
export function correctionsPrompt(corrections: Correction[], limit = 30): string {
  if (!corrections.length) return '';
  const lines = corrections.slice(-limit).map((c) => {
    const model = c.modelName === c.currentName ? `kept "${c.modelName}"` : `picked "${c.modelName}"`;
    return `- ${c.date} ${c.slot}: the assistant ${model}; the user chose "${c.userName}" instead.`;
  });
  return `

PAST CORRECTIONS — times the user overrode the assistant's pick. They reveal the user's taste
beyond the guidelines: a dish the user keeps rejecting should not be picked again, and a kind of
dish the user keeps choosing should be favoured when it is offered. The guidelines still win.
${lines.join('\n')}
`;
}

/** Rebuild model input from a logged day. The log keeps names + kcal only, not ingredients. */
export function slotsFromLog(day: LoggedDay): SlotInput[] {
  return day.slots.map((s) => {
    const current: MenuMeal = {
      mealName: s.slot,
      menuMealName: s.currentName,
      deliveryMealId: 0,
      dietCaloriesMealId: s.currentId,
      switchable: s.editable,
      allergens: [],
      ingredients: [],
      kcal: s.currentKcal,
    };
    const options = s.options.map(
      (o): SwitchOption => ({
        dietOptionName: o.variant ?? '',
        canBeChanged: true,
        mealName: s.slot,
        menuMealName: o.name,
        dietCaloriesMealId: o.id,
        allergens: [],
        ingredients: [],
        kcal: o.kcal,
      }),
    );
    return { current, options, editable: s.editable };
  });
}

export interface ReplayResult {
  correction: Correction;
  /** the model's pick with the guidelines alone */
  baselineId: number;
  /** the model's pick with the guidelines + every *other day's* corrections */
  learnedId: number;
}

type DecideDay = (slots: SlotInput[], guidelines: string, date: string) => Promise<{ slot: string; chosenId: number }[]>;

/**
 * Re-ask the model about each overridden day, with and without past corrections. A day's own
 * corrections are left out, so a match means the model generalised rather than memorised.
 */
export async function replayCorrections(corrections: Correction[], guidelines: string, decide: DecideDay): Promise<ReplayResult[]> {
  const results: ReplayResult[] = [];
  const days = new Map<string, Correction[]>();
  for (const c of corrections) {
    const key = `${c.orderId}|${c.date}`;
    days.set(key, [...(days.get(key) ?? []), c]);
  }
  for (const [key, dayCorrections] of days) {
    const others = corrections.filter((c) => `${c.orderId}|${c.date}` !== key);
    const { day, date } = dayCorrections[0]!;
    const slots = slotsFromLog(day);
    const baseline = await decide(slots, guidelines, date);
    const learned = await decide(slots, guidelines + correctionsPrompt(others), date);
    const pick = (ds: { slot: string; chosenId: number }[], slot: string) => ds.find((d) => d.slot === slot)?.chosenId ?? -1;
    for (const c of dayCorrections) {
      results.push({ correction: c, baselineId: pick(baseline, c.slot), learnedId: pick(learned, c.slot) });
    }
  }
  return results;
}
