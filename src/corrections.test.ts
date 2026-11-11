import assert from 'node:assert/strict';
import { test } from 'node:test';
import { correctionsPrompt, extractCorrections, replayCorrections } from './corrections.ts';
import type { LoggedDay, LogRecord } from './log.ts';

const opt = (id: number, name: string) => ({ id, name, variant: null, kcal: 500 });

/** Two days whose option ids collide (Dietly reuses them across days). */
const day = (date: string, names: [string, string, string]): LoggedDay => ({
  orderId: 1,
  date,
  deliveryId: 1,
  editable: true,
  slots: [
    {
      slot: 'Obiad',
      editable: true,
      currentId: 1,
      currentName: names[0],
      currentKcal: 500,
      currentVariant: null,
      suggestedId: 2,
      suggestedName: names[1],
      willChange: true,
      reason: '',
      options: [opt(1, names[0]), opt(2, names[1]), opt(3, names[2])],
    },
  ],
});

const log: LogRecord[] = [
  { kind: 'plan', ts: '2026-09-01T10:00:00Z', mode: 'dry-run', model: 'm', days: [day('2026-09-03', ['Tofu', 'Kurczak', 'Tacos'])] },
  { kind: 'plan', ts: '2026-09-01T10:00:00Z', mode: 'dry-run', model: 'm', days: [day('2026-09-04', ['Gulasz', 'Ryba', 'Burrito'])] },
  {
    kind: 'apply',
    ts: '2026-09-01T10:05:00Z',
    mode: 'apply',
    results: [
      { orderId: 1, deliveryId: 1, date: '2026-09-03', slot: 'Obiad', chosenId: 3, suggestedId: 2, ok: true, error: null },
      { orderId: 1, deliveryId: 1, date: '2026-09-04', slot: 'Obiad', chosenId: 2, suggestedId: 2, ok: true, error: null }, // accepted
      { orderId: 1, deliveryId: 1, date: '2026-09-04', slot: 'Obiad', chosenId: 3, suggestedId: 2, ok: false, error: 'x' }, // failed
    ],
  },
];

test('extracts only successful overrides, resolving names from that same day', () => {
  const cs = extractCorrections(log);
  assert.equal(cs.length, 1);
  assert.deepEqual(
    { date: cs[0]!.date, model: cs[0]!.modelName, user: cs[0]!.userName },
    { date: '2026-09-03', model: 'Kurczak', user: 'Tacos' },
  );
  assert.match(correctionsPrompt(cs), /2026-09-03 Obiad: the assistant picked "Kurczak"; the user chose "Tacos" instead/);
  assert.equal(correctionsPrompt([]), '');
});

test('replay leaves a day\'s own correction out of its prompt', async () => {
  const prompts: string[] = [];
  const results = await replayCorrections(extractCorrections(log), 'G', async (_slots, guidelines) => {
    prompts.push(guidelines);
    return [{ slot: 'Obiad', chosenId: 3 }];
  });
  assert.deepEqual(prompts, ['G', 'G']); // the only correction is excluded from its own replay
  assert.equal(results[0]!.learnedId, 3);
});
