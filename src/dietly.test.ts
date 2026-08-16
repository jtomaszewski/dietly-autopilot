import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DietlyClient } from './dietly.ts';

interface Call {
  url: string;
  method: string;
  company: string;
}

/** Stub fetch, recording the company-id header per call. */
function withFetch<T>(fn: (calls: Call[]) => Promise<T>): Promise<T> {
  const calls: Call[] = [];
  const real = globalThis.fetch;
  globalThis.fetch = (async (input: string, init: RequestInit = {}) => {
    const headers = (init.headers ?? {}) as Record<string, string>;
    calls.push({ url: String(input), method: init.method ?? 'GET', company: headers['company-id'] ?? '' });
    const body = String(input).includes('/profile-order/all')
      ? { results: [{ orderId: 7, status: 'ACTIVE', companyName: 'newcatering', dateFrom: '', dateTo: '', dietName: '', dietCalories: 0 }] }
      : { deliveryMenuMeal: [], mealChangeOptions: [], deliveries: [] };
    return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;
  return fn(calls).finally(() => {
    globalThis.fetch = real;
  });
}

test('order-scoped calls use the order own catering, not the configured default', async () => {
  await withFetch(async (calls) => {
    const client = new DietlyClient('oldcatering');
    await client.getOrder(7);
    await client.getDayMenu(7, 99);
    await client.getSwitchOptions(7, 99, 123);
    await client.swapMeal(7, 99, 123, 456);

    // The order list is fetched once under the default slug, then cached per order.
    assert.equal(calls.filter((c) => c.url.includes('/profile-order/all')).length, 1);
    const scoped = calls.filter((c) => !c.url.includes('/profile-order/all'));
    assert.equal(scoped.length, 4);
    for (const c of scoped) assert.equal(c.company, 'newcatering');
  });
});

test('an unknown order falls back to the configured catering', async () => {
  await withFetch(async (calls) => {
    const client = new DietlyClient('oldcatering');
    await client.getOrder(12345);
    const scoped = calls.filter((c) => !c.url.includes('/profile-order/all'));
    assert.deepEqual(
      scoped.map((c) => c.company),
      ['oldcatering'],
    );
  });
});
