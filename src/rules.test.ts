import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { MenuMeal, SwitchOption } from './dietly.ts';
import { decideDay, scoreOption, type SlotInput } from './rules.ts';

let id = 1000;
function opt(name: string, extra: Partial<SwitchOption> = {}): SwitchOption {
  return {
    dietOptionName: '',
    canBeChanged: true,
    mealName: 'Śniadanie',
    menuMealName: name,
    dietCaloriesMealId: id++,
    allergens: [],
    ingredients: [],
    kcal: null,
    ...extra,
  };
}
function menuFrom(o: SwitchOption, slot = 'Śniadanie'): MenuMeal {
  return {
    mealName: slot,
    menuMealName: o.menuMealName,
    deliveryMealId: 1,
    dietCaloriesMealId: o.dietCaloriesMealId,
    switchable: true,
    allergens: o.allergens,
    ingredients: o.ingredients,
    kcal: o.kcal,
  };
}
function slot(current: SwitchOption, options: SwitchOption[], editable = true): SlotInput {
  return { current: menuFrom(current), options: [current, ...options], editable };
}

test('vege/soy meat scores as a hard skip', () => {
  const s = scoreOption(opt('Potrawka z kotletami sojowymi z ryżem'));
  assert.equal(s.hardSkip, 'vege/soy meat');
});

test('soy sauce is NOT mistaken for vege-meat', () => {
  const s = scoreOption(opt('Kurczak w sosie sojowym z ryżem'));
  assert.equal(s.hardSkip, null);
  assert.ok(s.score >= 2, 'chicken should still score');
});

test('hard-skip current dish is swapped away even without a higher score', () => {
  const current = opt('Sałatka z wegańską fetą'); // hard skip
  const alt = opt('Schab po azjatycku z ryżem'); // neutral, score 0
  const [d] = decideDay([slot(current, [alt])]);
  assert.equal(d!.willChange, true);
  assert.equal(d!.chosenDish, 'Schab po azjatycku z ryżem');
});

test('no change for a trivial (< minImprovement) gain', () => {
  const current = opt('Indyk z ryżem'); // neutral 0
  const alt = opt('Makaron z warzywami'); // +1 pasta only
  const [d] = decideDay([slot(current, [alt])]);
  assert.equal(d!.willChange, false);
});

test('egg upgrade triggers a change', () => {
  const current = opt('Sałatka warzywna'); // 0
  const alt = opt('Frittata z boczkiem'); // +3 egg
  const [d] = decideDay([slot(current, [alt])]);
  assert.equal(d!.willChange, true);
  assert.match(d!.chosenDish, /Frittata/);
});

test('escapes a strong-avoid (porridge) breakfast', () => {
  const current = opt('Owsianka z gruszką'); // -5 porridge
  const alt = opt('Kanapka z szynką'); // 0 → +5 gain
  const [d] = decideDay([slot(current, [alt])]);
  assert.equal(d!.willChange, true);
});

test('per-day shake cap: only one shake survives', () => {
  const decisions = decideDay([
    slot(opt('Koktajl truskawkowy', { mealName: 'II Śniadanie' }), [opt('Jajecznica', { mealName: 'II Śniadanie' })]),
    slot(opt('Smoothie zielone', { mealName: 'Podwieczorek' }), [opt('Zupa krem', { mealName: 'Podwieczorek' })]),
  ]);
  const shakes = decisions.filter((d) => d.isShake);
  assert.equal(shakes.length, 1, 'at most one shake per day');
});

test('locked slots are never changed', () => {
  const current = opt('Sałatka z wegańską fetą'); // hard skip, but locked
  const alt = opt('Schab z ryżem');
  const [d] = decideDay([slot(current, [alt], false)]);
  assert.equal(d!.willChange, false);
  assert.equal(d!.editable, false);
});
