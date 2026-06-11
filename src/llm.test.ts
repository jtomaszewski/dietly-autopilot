import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { MenuMeal, SwitchOption } from './dietly.ts';
import { applyDecisions, buildDayPayload, keepAllDecisions, type SlotInput } from './llm.ts';

let id = 2000;
function opt(name: string, slot = 'Śniadanie'): SwitchOption {
  return {
    dietOptionName: 'SPORT',
    canBeChanged: true,
    mealName: slot,
    menuMealName: name,
    dietCaloriesMealId: id++,
    allergens: [],
    ingredients: [{ name: 'składnik', major: false }],
    kcal: 500,
    image: null,
  };
}
function asMenu(o: SwitchOption): MenuMeal {
  return {
    mealName: o.mealName,
    menuMealName: o.menuMealName,
    deliveryMealId: 1,
    dietCaloriesMealId: o.dietCaloriesMealId,
    switchable: true,
    allergens: o.allergens,
    ingredients: o.ingredients,
    kcal: o.kcal,
    image: null,
  };
}
function slot(current: SwitchOption, alts: SwitchOption[], editable = true): SlotInput {
  return { current: asMenu(current), options: [current, ...alts], editable };
}

test('buildDayPayload includes options only for editable slots', () => {
  const a = opt('Owsianka', 'Śniadanie');
  const b = opt('Frittata', 'Śniadanie');
  const locked = opt('Zupa', 'Obiad');
  const payload = buildDayPayload('2026-06-15', [slot(a, [b]), slot(locked, [opt('X', 'Obiad')], false)]) as {
    meals: Array<{ slot: string; editable: boolean; options: unknown[]; current: { name: string } }>;
  };
  assert.equal(payload.meals.length, 2);
  assert.equal(payload.meals[0]!.options.length, 2); // current + 1 alt
  assert.equal(payload.meals[1]!.options.length, 0); // locked → no options
  assert.equal(payload.meals[0]!.current.name, 'Owsianka');
});

test('applyDecisions honors a valid change', () => {
  const cur = opt('Owsianka');
  const alt = opt('Frittata z boczkiem');
  const [d] = applyDecisions([slot(cur, [alt])], [
    { slot: 'Śniadanie', action: 'change', dietCaloriesMealId: alt.dietCaloriesMealId, reason: 'avoid porridge' },
  ]);
  assert.equal(d!.willChange, true);
  assert.equal(d!.chosenDish, 'Frittata z boczkiem');
  assert.equal(d!.reason, 'avoid porridge');
});

test('applyDecisions rejects a target id that was not offered', () => {
  const cur = opt('Owsianka');
  const alt = opt('Frittata');
  const [d] = applyDecisions([slot(cur, [alt])], [
    { slot: 'Śniadanie', action: 'change', dietCaloriesMealId: 999999, reason: 'hallucinated id' },
  ]);
  assert.equal(d!.willChange, false); // guardrail: unknown id → keep
});

test('applyDecisions never changes a locked slot', () => {
  const cur = opt('Sałatka z wegańską fetą');
  const alt = opt('Schab');
  const [d] = applyDecisions([slot(cur, [alt], false)], [
    { slot: 'Śniadanie', action: 'change', dietCaloriesMealId: alt.dietCaloriesMealId, reason: 'skip vege cheese' },
  ]);
  assert.equal(d!.willChange, false);
  assert.equal(d!.editable, false);
});

test('applyDecisions keeps slots the model did not mention', () => {
  const cur = opt('Kurczak');
  const [d] = applyDecisions([slot(cur, [opt('Indyk')])], []);
  assert.equal(d!.willChange, false);
  assert.equal(d!.chosenId, cur.dietCaloriesMealId);
});

test('keepAllDecisions marks locked vs editable reason', () => {
  const editable = keepAllDecisions([slot(opt('A'), [], true)])[0]!;
  const locked = keepAllDecisions([slot(opt('B'), [], false)])[0]!;
  assert.equal(editable.reason, 'keep');
  assert.match(locked.reason, /locked/);
});
