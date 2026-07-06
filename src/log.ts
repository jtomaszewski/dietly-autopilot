/**
 * Append-only run log. Every plan/apply is recorded to `data/snapshots.jsonl` (one JSON object
 * per line) so you can later see what was on offer on any given day, what the model picked, and
 * what you actually applied — long after the day has locked and Dietly no longer exposes it.
 *
 * Zero dependencies; the file lives under `data/` (gitignored) so your meal history is never
 * committed. Logging failures are swallowed — they must never break a dry-run or an apply.
 */
import { appendFileSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { Plan, PlannedDay, SwapResult } from './planner.ts';

const SLOT_ORDER = ['Śniadanie', 'II Śniadanie', 'Obiad', 'Podwieczorek', 'Kolacja'];

export function logPath(): string {
  return process.env.DIETLY_LOG_PATH ?? 'data/snapshots.jsonl';
}

// ---- Record shapes ------------------------------------------------------------------------

export interface LoggedOption {
  id: number;
  name: string;
  variant: string | null;
  kcal: number | null;
}

export interface LoggedSlot {
  slot: string;
  editable: boolean;
  currentId: number;
  currentName: string;
  currentKcal: number | null;
  currentVariant: string | null;
  suggestedId: number;
  suggestedName: string;
  willChange: boolean;
  reason: string;
  options: LoggedOption[];
}

export interface LoggedDay {
  orderId: number;
  date: string;
  deliveryId: number;
  editable: boolean;
  slots: LoggedSlot[];
}

export interface PlanRecord {
  kind: 'plan';
  ts: string;
  mode: string;
  model: string;
  days: LoggedDay[];
}

export interface AppliedSwap {
  orderId: number;
  deliveryId: number;
  date: string | null;
  slot: string | null;
  chosenId: number;
  ok: boolean;
  error: string | null;
}

export interface ApplyRecord {
  kind: 'apply';
  ts: string;
  mode: string;
  results: AppliedSwap[];
}

export type LogRecord = PlanRecord | ApplyRecord;

// ---- Writing ------------------------------------------------------------------------------

function serializeDay(day: PlannedDay): LoggedDay {
  const slotByName = new Map(day.slots.map((s) => [s.current.mealName, s]));
  return {
    orderId: day.orderId,
    date: day.date,
    deliveryId: day.deliveryId,
    editable: day.editable,
    slots: [...day.decisions]
      .sort((a, b) => SLOT_ORDER.indexOf(a.slot) - SLOT_ORDER.indexOf(b.slot))
      .map((d) => {
        const slot = slotByName.get(d.slot)!;
        const currentVariant = slot.options.find((o) => o.dietCaloriesMealId === d.currentId)?.dietOptionName ?? null;
        return {
          slot: d.slot,
          editable: slot.editable,
          currentId: d.currentId,
          currentName: d.currentDish,
          currentKcal: slot.current.kcal,
          currentVariant,
          suggestedId: d.chosenId,
          suggestedName: d.chosenDish,
          willChange: d.willChange,
          reason: d.reason,
          options: slot.options.map((o) => ({
            id: o.dietCaloriesMealId,
            name: o.menuMealName,
            variant: o.dietOptionName || null,
            kcal: o.kcal,
          })),
        };
      }),
  };
}

function append(record: LogRecord): void {
  const path = logPath();
  try {
    mkdirSync(dirname(path), { recursive: true });
    appendFileSync(path, JSON.stringify(record) + '\n');
  } catch (e) {
    console.warn(`  ⚠️  could not write run log (${(e as Error).message})`);
  }
}

/** Record a full plan (all days, all slots, all options + the model's pick). */
export function logPlan(plan: Plan, meta: { mode: string; model: string; now?: string }): void {
  if (!plan.days.length) return;
  append({
    kind: 'plan',
    ts: meta.now ?? new Date().toISOString(),
    mode: meta.mode,
    model: meta.model,
    days: plan.days.map(serializeDay),
  });
}

/** Record what was actually committed to Dietly. */
export function logApply(results: SwapResult[], meta: { mode: string; now?: string }): void {
  if (!results.length) return;
  append({
    kind: 'apply',
    ts: meta.now ?? new Date().toISOString(),
    mode: meta.mode,
    results: results.map((r) => ({
      orderId: r.orderId,
      deliveryId: r.deliveryId,
      date: r.date ?? null,
      slot: r.slot ?? null,
      chosenId: r.dietCaloriesMealId,
      ok: r.ok,
      error: r.error ?? null,
    })),
  });
}

// ---- Reading / aggregation ----------------------------------------------------------------

export function readLog(): LogRecord[] {
  let txt: string;
  try {
    txt = readFileSync(logPath(), 'utf8');
  } catch {
    return [];
  }
  const out: LogRecord[] = [];
  for (const line of txt.split('\n')) {
    if (!line.trim()) continue;
    try {
      out.push(JSON.parse(line) as LogRecord);
    } catch {
      // skip a corrupt line rather than fail the whole history view
    }
  }
  return out;
}

export interface HistorySlot extends LoggedSlot {
  /** id we actually applied for this slot (from an apply record), if any */
  appliedId: number | null;
}
export interface HistoryDay extends Omit<LoggedDay, 'slots'> {
  loggedAt: string;
  slots: HistorySlot[];
}

/**
 * Collapse the append-only log into one entry per delivery date: the most recent plan snapshot
 * wins (menus/options are stable once published), annotated with the choice actually applied.
 * Newest date first. Pure — safe to unit-test.
 */
export function buildHistory(records: LogRecord[]): { days: HistoryDay[] } {
  const byDate = new Map<string, LoggedDay & { loggedAt: string }>();
  const applied = new Map<string, number>(); // `${date}|${slot}` -> chosenId (latest successful)

  for (const r of records) {
    if (r.kind === 'plan') {
      for (const day of r.days) byDate.set(day.date, { ...day, loggedAt: r.ts });
    } else {
      for (const res of r.results) {
        if (res.ok && res.date && res.slot) applied.set(`${res.date}|${res.slot}`, res.chosenId);
      }
    }
  }

  const days: HistoryDay[] = [...byDate.values()].map((day) => ({
    ...day,
    slots: day.slots.map((s) => ({ ...s, appliedId: applied.get(`${day.date}|${s.slot}`) ?? null })),
  }));
  days.sort((a, b) => b.date.localeCompare(a.date));
  return { days };
}
