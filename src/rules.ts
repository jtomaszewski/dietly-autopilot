/**
 * Pure preference engine: given the current meals for a day and the available
 * switch options per slot, decide what (if anything) to change. No I/O here so it
 * is trivially unit-testable.
 */
import type { MenuMeal, SwitchOption } from './dietly.ts';
import { guidelines, type Guidelines, type MatchRule, type WeightedRule } from './guidelines.ts';

const lc = (s: string) => s.toLowerCase();
const matchesAny = (text: string, r: MatchRule) => r.any.some((p) => text.includes(p));

export interface ScoredOption {
  option: SwitchOption;
  score: number;
  reasons: string[];
  hardSkip: string | null; // label of the hard-skip rule it violates, or null
  isShake: boolean;
}

function nameText(o: SwitchOption): string {
  return lc(o.menuMealName);
}

function fullText(o: SwitchOption): string {
  return lc(`${o.menuMealName} ${o.ingredients.map((i) => i.name).join(' ')}`);
}

export function scoreOption(o: SwitchOption, g: Guidelines = guidelines): ScoredOption {
  const name = nameText(o);
  const full = fullText(o);

  const hardSkip = g.hardSkip.find((r) => matchesAny(full, r))?.label ?? null;
  const isShake = matchesAny(full, { label: 'shake', any: g.shake.any });

  let score = 0;
  const reasons: string[] = [];
  for (const r of g.prefer as WeightedRule[]) {
    if (matchesAny(name, r)) {
      score += r.weight;
      reasons.push(`+${r.weight} ${r.label}`);
    }
  }
  for (const r of g.strongAvoid as WeightedRule[]) {
    if (matchesAny(name, r)) {
      score -= r.weight;
      reasons.push(`-${r.weight} ${r.label}`);
    }
  }
  return { option: o, score, reasons, hardSkip, isShake };
}

/** Best allowed candidate for a slot. `allowShake=false` excludes shakes. Returns null if none allowed. */
function best(scored: ScoredOption[], allowShake: boolean): ScoredOption | null {
  const eligible = scored.filter((s) => !s.hardSkip && (allowShake || !s.isShake));
  if (!eligible.length) return null;
  // Highest score wins; ties broken by keeping it stable (first in API order).
  return eligible.reduce((a, b) => (b.score > a.score ? b : a));
}

/** Treat the currently-chosen meal as a scoreable option (it usually is one of the switch options). */
function currentAsOption(m: MenuMeal): SwitchOption {
  return {
    dietOptionName: '',
    canBeChanged: true,
    mealName: m.mealName,
    menuMealName: m.menuMealName,
    dietCaloriesMealId: m.dietCaloriesMealId,
    allergens: m.allergens,
    ingredients: m.ingredients,
    kcal: m.kcal,
  };
}

const isStrongAvoid = (s: ScoredOption) => s.reasons.some((r) => r.startsWith('-'));

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
  isShake: boolean;
  reason: string;
}

/**
 * Decide all slots for a single day, enforcing the per-day shake cap across slots.
 */
export function decideDay(slots: SlotInput[], g: Guidelines = guidelines): SlotDecision[] {
  const minGain = g.minImprovement ?? 2;

  // 1. Score every option per slot; identify the current dish and the best candidates.
  const prepared = slots.map((s) => {
    const scored = s.options.map((o) => scoreOption(o, g));
    const current =
      scored.find((x) => x.option.dietCaloriesMealId === s.current.dietCaloriesMealId) ??
      scoreOption(currentAsOption(s.current), g);
    return { slot: s, scored, current, bestAny: best(scored, true), bestNoShake: best(scored, false) };
  });

  // 2. Per slot, decide whether to change. Only act when there's a real reason:
  //    a hard-skip on the current dish, a strong-avoid we can improve on, or a gain ≥ minGain.
  const picks = prepared.map((p) => {
    let target = p.current;
    let changed = false;
    if (p.slot.editable && p.bestAny) {
      const cur = p.current;
      const cand = p.bestAny;
      const isDifferent = cand.option.dietCaloriesMealId !== cur.option.dietCaloriesMealId;
      const forceLeave = cur.hardSkip != null; // current dish is forbidden → must leave if we can
      const escapeAvoid = isStrongAvoid(cur) && cand.score > cur.score; // current is e.g. porridge/stew
      const clearUpgrade = cand.score - cur.score >= minGain;
      if (isDifferent && (forceLeave || escapeAvoid || clearUpgrade)) {
        target = cand;
        changed = true;
      }
    }
    return { p, target, changed };
  });

  // 3. Enforce the per-day shake cap. Keep current shakes preferentially (less churn),
  //    then highest-scoring; demote the rest to their best non-shake option.
  const shakePicks = picks.filter((x) => x.p.slot.editable && x.target.isShake);
  if (shakePicks.length > g.shake.max) {
    const ranked = [...shakePicks].sort(
      (a, b) => Number(a.changed) - Number(b.changed) || b.target.score - a.target.score,
    );
    for (const x of ranked.slice(g.shake.max)) {
      const alt = x.p.bestNoShake;
      if (alt) {
        x.target = alt;
        x.changed = alt.option.dietCaloriesMealId !== x.p.current.option.dietCaloriesMealId;
      }
    }
  }

  // 4. Emit decisions.
  return picks.map(({ p, target, changed }): SlotDecision => {
    const cur = p.slot.current;
    const willChange = p.slot.editable && changed;
    return {
      slot: cur.mealName,
      currentDish: cur.menuMealName,
      currentId: cur.dietCaloriesMealId,
      chosenDish: target.option.menuMealName,
      chosenId: target.option.dietCaloriesMealId,
      willChange,
      editable: p.slot.editable,
      isShake: target.isShake,
      reason: explain(p.current, target, willChange, p.slot.editable),
    };
  });
}

function explain(
  current: ScoredOption,
  chosen: ScoredOption,
  willChange: boolean,
  editable: boolean,
): string {
  if (!editable) return 'locked (past edit cutoff)';
  if (!willChange) {
    if (current.hardSkip) return `keep (no allowed alternative; current is ${current.hardSkip})`;
    return 'keep (already best allowed)';
  }
  const why: string[] = [];
  if (current.hardSkip) why.push(`current is ${current.hardSkip}`);
  else if (isStrongAvoid(current)) why.push('avoid current');
  if (chosen.reasons.length) why.push(chosen.reasons.join(', '));
  why.push(`score ${current.score} → ${chosen.score}`);
  return why.join('; ');
}
