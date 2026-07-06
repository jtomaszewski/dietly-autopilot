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

function samplePlan(): Plan {
  const day: PlannedDay = {
    orderId: 42,
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
  return { orders: [], days: [day], unpublishedByOrder: new Map() };
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
    logPlan({ orders: [], days: [], unpublishedByOrder: new Map() }, { mode: 'dry-run', model: 'm' });
    assert.equal(readLog().length, 0);
  });
});

test('buildHistory merges the applied choice and keeps the latest snapshot per date', () => {
  withLog(() => {
    // Two dry-run snapshots for the same day (latest should win) …
    logPlan(samplePlan(), { mode: 'dry-run', model: 'm', now: '2026-07-06T09:00:00.000Z' });
    logPlan(samplePlan(), { mode: 'dry-run', model: 'm', now: '2026-07-06T10:00:00.000Z' });
    // … then an apply that committed option #2.
    const results: SwapResult[] = [
      { orderId: 42, deliveryId: 7, deliveryMealId: 1001, dietCaloriesMealId: 2, date: '2026-07-09', slot: 'Obiad', ok: true },
    ];
    logApply(results, { mode: 'apply', now: '2026-07-06T11:00:00.000Z' });

    const { days } = buildHistory(readLog());
    assert.equal(days.length, 1);
    assert.equal(days[0]!.loggedAt, '2026-07-06T10:00:00.000Z');
    assert.equal(days[0]!.slots[0]!.appliedId, 2);
  });
});

test('buildHistory ignores failed applies', () => {
  withLog(() => {
    logPlan(samplePlan(), { mode: 'dry-run', model: 'm', now: '2026-07-06T09:00:00.000Z' });
    const results: SwapResult[] = [
      { orderId: 42, deliveryId: 7, deliveryMealId: 1001, dietCaloriesMealId: 2, date: '2026-07-09', slot: 'Obiad', ok: false, error: 'boom' },
    ];
    logApply(results, { mode: 'apply', now: '2026-07-06T11:00:00.000Z' });
    const { days } = buildHistory(readLog());
    assert.equal(days[0]!.slots[0]!.appliedId, null);
  });
});
