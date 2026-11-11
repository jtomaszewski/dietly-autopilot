import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { MenuMeal } from './dietly.ts';
import type { SlotDecision } from './llm.ts';
import type { Plan, PlannedDay } from './planner.ts';
import { renderSummaryEmail, summarizeDays } from './summary.ts';

const meal = (mealName: string, menuMealName: string, id: number, kcal: number): MenuMeal => ({
  mealName,
  menuMealName,
  deliveryMealId: 1,
  dietCaloriesMealId: id,
  switchable: true,
  allergens: [],
  ingredients: [],
  kcal,
});

const decision = (slot: string, current: [string, number], chosen: [string, number], reason = 'keep'): SlotDecision => ({
  slot,
  currentDish: current[0],
  currentId: current[1],
  chosenDish: chosen[0],
  chosenId: chosen[1],
  willChange: current[1] !== chosen[1],
  editable: true,
  reason,
});

/** A Monday with a soy dinner the model swaps for chicken, and a kept breakfast. */
function day(date: string, editable = true): PlannedDay {
  return {
    orderId: 7,
    date,
    deliveryId: 70,
    editable,
    slots: [
      { current: meal('Śniadanie', 'Jajecznica', 1, 500), options: [], editable },
      {
        current: meal('Kolacja', 'Kotlety sojowe', 2, 600),
        options: [{ dietOptionName: 'STD', canBeChanged: true, mealName: 'Kolacja', menuMealName: 'Kurczak', dietCaloriesMealId: 3, kcal: 650 } as never],
        editable,
      },
    ],
    decisions: [
      decision('Kolacja', ['Kotlety sojowe', 2], editable ? ['Kurczak', 3] : ['Kotlety sojowe', 2], 'soy meat'),
      decision('Śniadanie', ['Jajecznica', 1], ['Jajecznica', 1]),
    ],
  };
}

const plan = (days: PlannedDay[]): Plan => ({ orders: [], availableOrders: [], days, unpublishedByOrder: new Map() });

test('dry-run: shows the proposed dish, its kcal, and slots in meal order', () => {
  const [d] = summarizeDays(plan([day('2026-11-16')]), null, null);
  assert.deepEqual(d!.slots.map((s) => s.slot), ['Śniadanie', 'Kolacja']);
  assert.deepEqual(d!.slots[1], {
    slot: 'Kolacja',
    dish: 'Kurczak',
    kcal: 650,
    change: { from: 'Kotlety sojowe', reason: 'soy meat', status: 'proposed' },
  });
  assert.equal(d!.slots[0]!.change, undefined);
});

test('apply: the re-fetched menu wins and failed swaps are flagged', () => {
  const after = day('2026-11-16');
  after.slots[1]!.current = meal('Kolacja', 'Kurczak (po zmianie)', 3, 640);
  const ok = summarizeDays(
    plan([day('2026-11-16')]),
    [{ orderId: 7, deliveryId: 70, deliveryMealId: 1, dietCaloriesMealId: 3, date: '2026-11-16', slot: 'Kolacja', ok: true }],
    plan([after]),
  );
  assert.equal(ok[0]!.slots[1]!.dish, 'Kurczak (po zmianie)');
  assert.equal(ok[0]!.slots[1]!.change?.status, 'applied');

  const failed = summarizeDays(
    plan([day('2026-11-16')]),
    [{ orderId: 7, deliveryId: 70, deliveryMealId: 1, dietCaloriesMealId: 3, date: '2026-11-16', slot: 'Kolacja', ok: false, error: '409' }],
    null,
  );
  assert.equal(failed[0]!.slots[1]!.dish, 'Kotlety sojowe');
  assert.deepEqual(failed[0]!.slots[1]!.change, { from: 'Kotlety sojowe', reason: 'soy meat', status: 'failed', error: '409' });
});

test('email covers every upcoming day, notes unpublished ones, escapes dish names', () => {
  const days = summarizeDays(plan([day('2026-11-16', false), day('2026-11-17'), day('2026-11-24')]), null, null);
  days[1]!.slots[0]!.dish = 'Jajka <b>&</b> szynka';
  const { subject, html } = renderSummaryEmail(days, 'dry-run', 18);
  assert.equal(subject, '🥗 Dietly menu 16 Nov – 24 Nov (2 proposed)');
  assert.match(html, /Monday 16 Nov/);
  assert.match(html, /Tuesday 17 Nov/);
  assert.match(html, /Tuesday 24 Nov/);
  assert.match(html, /18 later day\(s\) not published by Dietly yet/);
  assert.match(html, /Jajka &lt;b&gt;&amp;&lt;\/b&gt; szynka/);
  assert.match(html, /🔒/);
});
