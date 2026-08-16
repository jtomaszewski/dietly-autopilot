import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Delivery, DietlyClient, MenuMeal, OrderSummary, SwitchOption } from './dietly.ts';
import { addDays, buildPlan, runningOrders, todayISO } from './planner.ts';

const order = (orderId: number, companyName: string, dateTo: string): OrderSummary => ({
  orderId,
  status: 'ACTIVE',
  dateFrom: addDays(todayISO(), -30),
  dateTo,
  companyName,
  dietName: 'Wybór menu',
  dietCalories: 3000,
});

/** Two cateries running side by side, plus one that already ended. */
function stubClient(): DietlyClient {
  const today = todayISO();
  const orders = [
    order(1, 'wybormenu', addDays(today, -1)), // finished yesterday
    order(2, 'wybormenu', addDays(today, 5)),
    order(3, 'dobregodniacatering', addDays(today, 5)),
  ];
  const meal: MenuMeal = {
    mealName: 'Obiad',
    menuMealName: 'Kurczak z ryżem',
    deliveryMealId: 10,
    dietCaloriesMealId: 100,
    switchable: true,
    allergens: [],
    ingredients: [],
    kcal: 700,
  };
  const opt: SwitchOption = {
    dietOptionName: 'OPTIMAL',
    canBeChanged: true,
    mealName: 'Obiad',
    menuMealName: 'Kurczak z ryżem',
    dietCaloriesMealId: 100,
    allergens: [],
    ingredients: [],
    kcal: 700,
  };
  const delivery: Delivery = { deliveryId: 500, date: addDays(today, 2), deleted: false, deliveryMeals: [] };

  return {
    getActiveOrders: async () => orders,
    getOrder: async () => ({ deliveries: [delivery] }),
    getDayMenu: async () => [meal],
    getSwitchOptions: async () => [opt],
  } as unknown as DietlyClient;
}

const cfg = { guidelines: '', model: 'test', openRouterApiKey: 'test' };

test('runningOrders keeps every catering, drops orders that already ended', async () => {
  const running = await runningOrders(stubClient());
  assert.deepEqual(running.map((o) => o.orderId), [2, 3]);
});

test('a plan covers all running orders and reports them as switchable alternatives', async () => {
  const plan = await buildPlan(stubClient(), cfg, { days: 7, decide: false });
  assert.deepEqual(plan.orders.map((o) => o.orderId), [2, 3]);
  assert.deepEqual(plan.availableOrders.map((o) => o.orderId), [2, 3]);
  assert.deepEqual(plan.days.map((d) => d.orderId), [2, 3]);
});

test('picking one order narrows the plan but still lists the others to switch to', async () => {
  const plan = await buildPlan(stubClient(), cfg, { days: 7, order: 3, decide: false });
  assert.deepEqual(plan.orders.map((o) => o.orderId), [3]);
  assert.deepEqual(plan.days.map((d) => d.orderId), [3]);
  assert.deepEqual(plan.availableOrders.map((o) => o.orderId), [2, 3]);
});
