/**
 * LLM decision-maker. Per day, the model receives the user's guidelines (markdown) plus the
 * day's slots (current dish + available alternatives) and decides, per slot, keep or change.
 *
 * The model owns the *decision*; this module only does I/O, builds a compact payload, and
 * applies thin guardrails (a chosen dish must be a real offered option for an editable slot).
 */
import type { MenuMeal, SwitchOption } from './dietly.ts';

const ENDPOINT = 'https://openrouter.ai/api/v1/chat/completions';

export interface SlotInput {
  current: MenuMeal;
  options: SwitchOption[];
  /** false when the day/slot is past its edit cutoff */
  editable: boolean;
}

export interface SlotDecision {
  slot: string; // meal name (Śniadanie ...)
  currentDish: string;
  currentId: number;
  chosenDish: string;
  chosenId: number;
  willChange: boolean;
  editable: boolean;
  reason: string;
}

// ---- Payload sent to the model ------------------------------------------------------------

interface MealView {
  dietCaloriesMealId: number;
  name: string;
  variant?: string;
  allergens: string[];
  ingredients: string[];
  kcal: number | null;
}

const mealView = (m: MenuMeal): MealView => ({
  dietCaloriesMealId: m.dietCaloriesMealId,
  name: m.menuMealName,
  allergens: m.allergens,
  ingredients: m.ingredients.map((i) => i.name),
  kcal: m.kcal,
});

const optionView = (o: SwitchOption): MealView => ({
  dietCaloriesMealId: o.dietCaloriesMealId,
  name: o.menuMealName,
  variant: o.dietOptionName || undefined,
  allergens: o.allergens,
  ingredients: o.ingredients.map((i) => i.name),
  kcal: o.kcal,
});

/** Compact, model-friendly JSON for one day. Options are only sent for editable slots. */
export function buildDayPayload(date: string, slots: SlotInput[]): unknown {
  return {
    date,
    meals: slots.map((s) => ({
      slot: s.current.mealName,
      editable: s.editable,
      current: mealView(s.current),
      options: s.editable ? s.options.map(optionView) : [],
    })),
  };
}

// ---- Structured-output contract -----------------------------------------------------------

interface RawDecision {
  slot: string;
  action: 'keep' | 'change';
  dietCaloriesMealId: number | null;
  reason: string;
}

const RESPONSE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    shakeSlots: {
      type: 'array',
      items: { type: 'string' },
      description:
        "Slot names whose CURRENT dish is itself a shake/smoothie (koktajl/smoothie) — look only at 'current', never 'options'. Fill this FIRST. Only if it has 2+ entries may you change a slot to satisfy the one-shake-per-day limit.",
    },
    decisions: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          slot: { type: 'string', description: 'The meal slot name, exactly as given' },
          action: { type: 'string', enum: ['keep', 'change'] },
          dietCaloriesMealId: {
            type: ['number', 'null'],
            description: 'For action=change, the dietCaloriesMealId of a provided option; otherwise null',
          },
          reason: { type: 'string', description: 'Short justification referencing the guidelines' },
        },
        required: ['slot', 'action', 'dietCaloriesMealId', 'reason'],
      },
    },
  },
  required: ['shakeSlots', 'decisions'],
} as const;

const SYSTEM_PROMPT = `You are a meal-selection assistant for a Polish meal-catering subscription.
You are given the user's dietary GUIDELINES and ONE day's meals as JSON. Each slot has a
"current" dish and, if editable, an "options" list.

Critical facts about the data:
- ONLY the dish in each slot's "current" field is actually on the plate that day. The "options"
  are merely alternatives you COULD switch to — they are NOT extra meals. Never count options
  when evaluating day-level limits.
- Base every decision and reason strictly on the provided names/ingredients/allergens. Do NOT
  invent ingredients or properties that aren't in the data.

For every slot, decide "keep" or "change":
- Only change an editable slot, and only to an id present in that slot's "options". Put that id in
  "dietCaloriesMealId". For "keep", use null and never invent an id.
- Default to KEEP. Only change when a guideline clearly demands it. A "never pick" item must always
  be swapped. "Avoid"/"prefer" justify a change only when the CURRENT dish clearly matches an
  avoid category, or the current dish is genuinely worse than a clearly-preferred alternative.
  Do not swap a perfectly fine savory breakfast (meat, fish, eggs) just to chase "prefer eggs".
  Note: twaróg / cottage cheese is dairy, NOT an egg dish.
- If the current dish already belongs to a preferred category (e.g. it is already chicken, fish, or
  eggs) or is otherwise acceptable, KEEP it — never swap one preferred dish for another (e.g. fish
  → other fish, chicken → other chicken). That is needless churn.
- Shake limit procedure: FIRST fill "shakeSlots" with the slots whose CURRENT dish is a shake/
  smoothie (ignore options entirely). A single shake a day is allowed — if "shakeSlots" has 0 or 1
  entries, make NO shake-motivated changes. Only if it has 2+ entries, keep the best one shake and
  switch the others to a non-shake. A soup, cake, dessert, or pudding is NOT a shake.
- Return exactly one decision per slot you were given, using the slot name verbatim.

GUIDELINES:
`;

// ---- Public API ---------------------------------------------------------------------------

export interface DecideArgs {
  slots: SlotInput[];
  guidelines: string;
  model: string;
  apiKey: string;
  date: string;
}

/** Build keep-everything decisions (used for locked days and as a fail-safe). */
export function keepAllDecisions(slots: SlotInput[]): SlotDecision[] {
  return slots.map((s) => ({
    slot: s.current.mealName,
    currentDish: s.current.menuMealName,
    currentId: s.current.dietCaloriesMealId,
    chosenDish: s.current.menuMealName,
    chosenId: s.current.dietCaloriesMealId,
    willChange: false,
    editable: s.editable,
    reason: s.editable ? 'keep' : 'locked (past edit cutoff)',
  }));
}

/**
 * Map raw model decisions onto slots, enforcing guardrails: a change is only honored if the slot
 * is editable and the target id is one of that slot's offered options. Pure + testable.
 */
export function applyDecisions(slots: SlotInput[], raw: RawDecision[]): SlotDecision[] {
  const bySlot = new Map(raw.map((d) => [d.slot, d]));
  return slots.map((s) => {
    const base = keepAllDecisions([s])[0]!;
    const d = bySlot.get(s.current.mealName);
    if (!s.editable || !d || d.action !== 'change' || d.dietCaloriesMealId == null) {
      return d?.reason ? { ...base, reason: s.editable ? d.reason : base.reason } : base;
    }
    const target = s.options.find((o) => o.dietCaloriesMealId === d.dietCaloriesMealId);
    if (!target || target.dietCaloriesMealId === s.current.dietCaloriesMealId) {
      return { ...base, reason: d.reason || base.reason };
    }
    return {
      ...base,
      chosenDish: target.menuMealName,
      chosenId: target.dietCaloriesMealId,
      willChange: true,
      reason: d.reason || 'changed per guidelines',
    };
  });
}

async function callOpenRouter(args: DecideArgs): Promise<RawDecision[]> {
  const body = {
    model: args.model,
    temperature: 0,
    messages: [
      { role: 'system', content: SYSTEM_PROMPT + args.guidelines },
      { role: 'user', content: JSON.stringify(buildDayPayload(args.date, args.slots)) },
    ],
    response_format: {
      type: 'json_schema',
      json_schema: { name: 'meal_decisions', strict: true, schema: RESPONSE_SCHEMA },
    },
  };
  const res = await fetch(ENDPOINT, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${args.apiKey}`,
      'Content-Type': 'application/json',
      'HTTP-Referer': 'https://github.com/jtomaszewski/dietly-autopilot',
      'X-Title': 'dietly-autopilot',
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`OpenRouter ${res.status}: ${(await res.text()).slice(0, 300)}`);
  const data = (await res.json()) as { choices?: Array<{ message?: { content?: string } }> };
  const content = data.choices?.[0]?.message?.content;
  if (!content) throw new Error('OpenRouter returned no content');
  const parsed = JSON.parse(content) as { decisions?: RawDecision[] };
  if (!Array.isArray(parsed.decisions)) throw new Error('Model output missing "decisions" array');
  return parsed.decisions;
}

/** Decide a single day via the LLM. Fail-safe: on any error, keep all meals for the day. */
export async function decideDayLLM(args: DecideArgs): Promise<SlotDecision[]> {
  if (!args.slots.some((s) => s.editable)) return keepAllDecisions(args.slots);
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const raw = await callOpenRouter(args);
      return applyDecisions(args.slots, raw);
    } catch (e) {
      if (attempt === 1) {
        console.warn(`  ⚠️  ${args.date}: LLM decision failed (${(e as Error).message}); keeping meals.`);
        return keepAllDecisions(args.slots);
      }
    }
  }
  return keepAllDecisions(args.slots);
}
