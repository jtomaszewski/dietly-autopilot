#!/usr/bin/env node
/**
 * Tiny zero-dependency web server for dietly-autopilot.
 *
 *   node src/server.ts            # http://127.0.0.1:4505
 *
 * Serves a single-page UI and a small JSON API that reuses the same planner the CLI does.
 * Binds to localhost only; your Dietly password and OpenRouter key never leave the server.
 */
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { loadConfig } from './config.ts';
import { DietlyClient } from './dietly.ts';
import { applySwaps, buildPlan, type PlannedDay, type SwapRequest } from './planner.ts';

const cfg = loadConfig();
const HOST = process.env.HOST ?? '127.0.0.1';
const PORT = Number(process.env.PORT ?? '4505');
const INDEX = join(dirname(fileURLToPath(import.meta.url)), '..', 'web', 'index.html');

/** Read the guidelines fresh from disk (the user may have edited them in the UI). */
function freshGuidelines(): string {
  return readFileSync(cfg.guidelinesPath, 'utf8');
}

async function loggedInClient(): Promise<DietlyClient> {
  const client = new DietlyClient(cfg.companyId);
  await client.login(cfg.email, cfg.password);
  return client;
}

/** Flatten a PlannedDay into the shape the browser renders. */
function serializeDay(day: PlannedDay) {
  return {
    orderId: day.orderId,
    date: day.date,
    deliveryId: day.deliveryId,
    editable: day.editable,
    slots: day.decisions
      .map((d) => {
        const slot = day.slots.find((s) => s.current.mealName === d.slot)!;
        return {
          slot: d.slot,
          editable: slot.editable,
          deliveryMealId: slot.current.deliveryMealId,
          currentId: d.currentId,
          currentName: d.currentDish,
          currentKcal: slot.current.kcal,
          suggestedId: d.chosenId,
          willChange: d.willChange,
          reason: d.reason,
          options: slot.options.map((o) => ({
            id: o.dietCaloriesMealId,
            name: o.menuMealName,
            variant: o.dietOptionName,
            kcal: o.kcal,
          })),
        };
      })
      .sort((a, b) => SLOT_ORDER.indexOf(a.slot) - SLOT_ORDER.indexOf(b.slot)),
  };
}

const SLOT_ORDER = ['Śniadanie', 'II Śniadanie', 'Obiad', 'Podwieczorek', 'Kolacja'];

function send(res: ServerResponse, status: number, body: unknown, type = 'application/json'): void {
  const payload = type === 'application/json' ? JSON.stringify(body) : String(body);
  res.writeHead(status, { 'Content-Type': type });
  res.end(payload);
}

async function readBody(req: IncomingMessage): Promise<any> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  const raw = Buffer.concat(chunks).toString('utf8');
  return raw ? JSON.parse(raw) : {};
}

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url ?? '/', `http://${HOST}:${PORT}`);
    const path = url.pathname;

    if (req.method === 'GET' && path === '/') {
      return send(res, 200, readFileSync(INDEX, 'utf8'), 'text/html; charset=utf-8');
    }

    if (req.method === 'GET' && path === '/api/config') {
      return send(res, 200, { model: cfg.model, companyId: cfg.companyId, horizonDays: cfg.horizonDays });
    }

    if (req.method === 'GET' && path === '/api/guidelines') {
      return send(res, 200, { text: freshGuidelines() });
    }

    if (req.method === 'POST' && path === '/api/guidelines') {
      const { text } = await readBody(req);
      if (typeof text !== 'string') return send(res, 400, { error: 'text required' });
      writeFileSync(cfg.guidelinesPath, text);
      return send(res, 200, { ok: true });
    }

    if (req.method === 'POST' && path === '/api/plan') {
      const { days } = await readBody(req);
      const client = await loggedInClient();
      const plan = await buildPlan(
        client,
        { ...cfg, guidelines: freshGuidelines() },
        { days: Number(days) || cfg.horizonDays },
      );
      return send(res, 200, {
        orders: plan.orders.map((o) => ({ orderId: o.orderId, dietName: o.dietName, dietCalories: o.dietCalories })),
        days: plan.days.map(serializeDay),
        unpublished: Object.fromEntries(plan.unpublishedByOrder),
      });
    }

    if (req.method === 'POST' && path === '/api/apply') {
      const { swaps } = (await readBody(req)) as { swaps: SwapRequest[] };
      if (!Array.isArray(swaps) || !swaps.length) return send(res, 400, { error: 'no swaps' });
      const client = await loggedInClient();
      const results = await applySwaps(client, swaps);
      return send(res, 200, { results });
    }

    return send(res, 404, { error: 'not found' });
  } catch (e) {
    return send(res, 500, { error: e instanceof Error ? e.message : String(e) });
  }
});

server.listen(PORT, HOST, () => {
  console.log(`dietly-autopilot UI → http://${HOST}:${PORT}  (model: ${cfg.model})`);
});
