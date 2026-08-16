import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import type { MenuMeal, SwitchOption } from './dietly.ts';
import { buildHistory, logApply, logPlan, readLog } from './log.ts';
import type { Plan, PlannedDay, SwapResult } from './planner.ts';

function withLog<T>(fn: () => T): T {
  const prev = process.env.DIETLY_LOG_PATH;
  process.env.DIETLY_LOG_PATH = join(mkdtempSync(join(tmpdir(), 'dietly-log-')), 'snapshots.jsonl');
  try {
    return fn();
  } finally {
    if (prev === undefined) delete process.env.DIETLY_LOG_PATH;
    else process.env.DIETLY_LOG_PATH = prev;
  }
}

const meal = (mealName: string, id: number, name: string): MenuMeal => ({
  mealName,
  menuMealName: name,
  deliveryMealId: 1000 + id,
  dietCaloriesMealId: id,
  switchable: true,
  allergens: [],
  ingredients: [],
  kcal: 500,
});

const opt = (id: number, name: string, variant: string): SwitchOption => ({
  dietOptionName: variant,
  canBeChanged: true,
  mealName: 'Obiad',
  menuMealName: name,
  dietCaloriesMealId: id,
  allergens: [],
  ingredients: [],
  kcal: 600,
});

function samplePlan(orderId = 42): Plan {
  const day: PlannedDay = {
    orderId,
    date: '2026-07-09',
    deliveryId: 7,
    editable: true,
    slots: [
      {
        current: meal('Obiad', 1, 'Ryż z kurczakiem'),
        options: [opt(1, 'Ryż z kurczakiem', 'SLIM'), opt(2, 'Schab w sosie grzybowym', 'SPORT')],
        editable: true,
      },
    ],
    decisions: [
      {
        slot: 'Obiad',
        currentDish: 'Ryż z kurczakiem',
        currentId: 1,
        chosenDish: 'Schab w sosie grzybowym',
        chosenId: 2,
        willChange: true,
        editable: true,
        reason: 'prefer pork today',
      },
    ],
  };
  return { orders: [], availableOrders: [], days: [day], unpublishedByOrder: new Map() };
}

test('logPlan writes a readable snapshot with options + suggestion', () => {
  withLog(() => {
    logPlan(samplePlan(), { mode: 'dry-run', model: 'test-model', now: '2026-07-06T09:00:00.000Z' });
    const records = readLog();
    assert.equal(records.length, 1);
    const rec = records[0];
    assert.ok(rec && rec.kind === 'plan');
    if (!rec || rec.kind !== 'plan') return;
    assert.equal(rec.model, 'test-model');
    const slot = rec.days[0]!.slots[0]!;
    assert.equal(slot.currentId, 1);
    assert.equal(slot.suggestedId, 2);
    assert.equal(slot.willChange, true);
    assert.equal(slot.currentVariant, 'SLIM');
    assert.equal(slot.options.length, 2);
  });
});

test('logPlan with no published days writes nothing', () => {
  withLog(() => {
    logPlan({ orders: [], availableOrders: [], days: [], unpublishedByOrder: new Map() }, { mode: 'dry-run', model: 'm' });
    assert.equal(readLog().length, 0);
  });
});

test('buildHistory merges the applied choice and keeps the latest snapshot per date', () => {
  withLog(() => {
    // Two dry-run snapshots for the same day (latest should win) …
    logPlan(samplePlan(), { mode: 'dry-run', model: 'm', now: '2026-07-06T09:00:00.000Z' });
    logPlan(samplePlan(), { mode: 'dry-run', model: 'm', now: '2026-07-06T10:00:00.000Z' });
    // … then an apply that committed the model's pick (#2), suggested == chosen.
    const results: SwapResult[] = [
      { orderId: 42, deliveryId: 7, deliveryMealId: 1001, dietCaloriesMealId: 2, date: '2026-07-09', slot: 'Obiad', suggestedId: 2, ok: true },
    ];
    logApply(results, { mode: 'apply', now: '2026-07-06T11:00:00.000Z' });

    const { days } = buildHistory(readLog());
    assert.equal(days.length, 1);
    assert.equal(days[0]!.loggedAt, '2026-07-06T10:00:00.000Z');
    assert.equal(days[0]!.slots[0]!.appliedId, 2);
    assert.equal(days[0]!.slots[0]!.overridden, false);
  });
});

test('buildHistory ignores failed applies', () => {
  withLog(() => {
    logPlan(samplePlan(), { mode: 'dry-run', model: 'm', now: '2026-07-06T09:00:00.000Z' });
    const results: SwapResult[] = [
      { orderId: 42, deliveryId: 7, deliveryMealId: 1001, dietCaloriesMealId: 2, date: '2026-07-09', slot: 'Obiad', suggestedId: 2, ok: false, error: 'boom' },
    ];
    logApply(results, { mode: 'apply', now: '2026-07-06T11:00:00.000Z' });
    const { days } = buildHistory(readLog());
    assert.equal(days[0]!.slots[0]!.appliedId, null);
  });
});

test('a post-apply snapshot updates current state but keeps the model suggestion + reason', () => {
  withLog(() => {
    // Model suggested #2 (a change) …
    logPlan(samplePlan(), { mode: 'dry-run', model: 'm', now: '2026-07-06T09:00:00.000Z' });
    // … we applied it, then a keep-all confirmation snapshot recorded current == #2.
    logApply(
      [{ orderId: 42, deliveryId: 7, deliveryMealId: 1001, dietCaloriesMealId: 2, date: '2026-07-09', slot: 'Obiad', suggestedId: 2, ok: true }],
      { mode: 'apply', now: '2026-07-06T09:05:00.000Z' },
    );
    const confirm = samplePlan();
    const slot = confirm.days[0]!.slots[0]!;
    slot.current = { ...slot.current, dietCaloriesMealId: 2, menuMealName: 'Schab w sosie grzybowym' };
    confirm.days[0]!.decisions = [
      { slot: 'Obiad', currentDish: 'Schab w sosie grzybowym', currentId: 2, chosenDish: 'Schab w sosie grzybowym', chosenId: 2, willChange: false, editable: true, reason: 'keep' },
    ];
    logPlan(confirm, { mode: 'post-apply', model: 'm', now: '2026-07-06T09:06:00.000Z' });

    const s = buildHistory(readLog()).days[0]!.slots[0]!;
    assert.equal(s.currentId, 2); // #2: current now reflects the applied dish
    assert.equal(s.reason, 'prefer pork today'); // decision snapshot preserved, not the keep-all one
    assert.equal(s.willChange, true);
    assert.equal(s.appliedId, 2);
  });
});

test('two orders delivering on the same date stay separate in the history', () => {
  withLog(() => {
    logPlan(samplePlan(42), { mode: 'dry-run', model: 'm', now: '2026-07-06T09:00:00.000Z' });
    logPlan(samplePlan(43), { mode: 'dry-run', model: 'm', now: '2026-07-06T09:01:00.000Z' });
    // Applied only on order 43 — order 42's identical date/slot must stay untouched.
    logApply(
      [{ orderId: 43, deliveryId: 7, deliveryMealId: 1001, dietCaloriesMealId: 2, date: '2026-07-09', slot: 'Obiad', suggestedId: 2, ok: true }],
      { mode: 'apply', now: '2026-07-06T09:05:00.000Z' },
    );

    const { days } = buildHistory(readLog());
    assert.deepEqual(days.map((d) => d.orderId), [42, 43]);
    assert.equal(days.find((d) => d.orderId === 42)!.slots[0]!.appliedId, null);
    assert.equal(days.find((d) => d.orderId === 43)!.slots[0]!.appliedId, 2);
  });
});

test('buildHistory flags a manual override via the apply record, even after a reload snapshot', () => {
  withLog(() => {
    // Model suggested #2 …
    logPlan(samplePlan(), { mode: 'dry-run', model: 'm', now: '2026-07-06T09:00:00.000Z' });
    // … but we manually applied option #3 instead.
    logApply(
      [{ orderId: 42, deliveryId: 7, deliveryMealId: 1001, dietCaloriesMealId: 3, date: '2026-07-09', slot: 'Obiad', suggestedId: 2, ok: true }],
      { mode: 'apply', now: '2026-07-06T09:05:00.000Z' },
    );
    // A later web-UI reload snapshot now sees #3 as current and suggests keeping it — must NOT
    // erase the fact that the model originally wanted #2.
    const reload = samplePlan();
    reload.days[0]!.slots[0]!.current = { ...reload.days[0]!.slots[0]!.current, dietCaloriesMealId: 3 };
    reload.days[0]!.decisions = [
      { slot: 'Obiad', currentDish: 'x', currentId: 3, chosenDish: 'x', chosenId: 3, willChange: false, editable: true, reason: 'keep' },
    ];
    logPlan(reload, { mode: 'dry-run', model: 'm', now: '2026-07-06T09:10:00.000Z' });

    const s = buildHistory(readLog()).days[0]!.slots[0]!;
    assert.equal(s.appliedId, 3);
    assert.equal(s.modelSuggestedId, 2); // recovered from the apply record
    assert.equal(s.overridden, true);
  });
});
