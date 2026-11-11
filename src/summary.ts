/**
 * Weekly email summary: the menu for the coming Monday–Sunday after a run, with what the run
 * changed (or would change, for dry-run) marked per slot.
 */
import { addDays, type Plan, type SwapResult } from './planner.ts';

export interface SummarySlot {
  slot: string;
  dish: string;
  kcal: number | null;
  change?: { from: string; reason: string; status: 'applied' | 'proposed' | 'failed'; error?: string };
}

export interface SummaryDay {
  orderId: number;
  date: string;
  locked: boolean;
  slots: SummarySlot[];
}

const SLOT_ORDER = ['Śniadanie', 'II Śniadanie', 'Obiad', 'Podwieczorek', 'Kolacja'];
const slotRank = (s: string) => (SLOT_ORDER.includes(s) ? SLOT_ORDER.indexOf(s) : 99);

/** Monday–Sunday of the week after `today` (on a Saturday: the day after tomorrow → +8). */
export function nextWeek(today: string): { from: string; to: string } {
  const dow = new Date(`${today}T00:00:00`).getDay(); // 0 = Sunday
  const from = addDays(today, ((8 - dow) % 7) || 7);
  return { from, to: addDays(from, 6) };
}

/**
 * Merge a run into per-day menus. `results` are the applied swaps (null for dry-run, where the
 * model's picks are shown as proposed); `after` is the re-fetched menu after applying, when any.
 */
export function summarizeDays(plan: Plan, results: SwapResult[] | null, after: Plan | null): SummaryDay[] {
  return plan.days
    .map((day) => {
      const afterDay = after?.days.find((d) => d.orderId === day.orderId && d.date === day.date);
      const slots = [...day.decisions]
        .sort((a, b) => slotRank(a.slot) - slotRank(b.slot))
        .map((d): SummarySlot => {
          const input = day.slots.find((s) => s.current.mealName === d.slot);
          const final = afterDay?.slots.find((s) => s.current.mealName === d.slot)?.current;
          const result = results?.find((r) => r.orderId === day.orderId && r.date === day.date && r.slot === d.slot);
          const proposed = !results && d.willChange;

          const dish = final?.menuMealName ?? (proposed ? d.chosenDish : d.currentDish);
          const kcal = final
            ? final.kcal
            : proposed
              ? (input?.options.find((o) => o.dietCaloriesMealId === d.chosenId)?.kcal ?? null)
              : (input?.current.kcal ?? null);

          const status = result ? (result.ok ? 'applied' : 'failed') : proposed ? 'proposed' : null;
          return {
            slot: d.slot,
            dish,
            kcal,
            ...(status && {
              change: { from: d.currentDish, reason: d.reason, status, ...(result?.error && { error: result.error }) },
            }),
          };
        });
      return { orderId: day.orderId, date: day.date, locked: !day.editable, slots };
    })
    .sort((a, b) => a.date.localeCompare(b.date) || a.orderId - b.orderId);
}

const esc = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

const fmtDate = (iso: string, opts: Intl.DateTimeFormatOptions) =>
  new Date(`${iso}T00:00:00`).toLocaleDateString('en-GB', opts);

const STATUS_LABEL = { applied: '✏️ changed', proposed: '💡 would change', failed: '❌ change failed' } as const;

function renderSlot(s: SummarySlot): string {
  const kcal = s.kcal != null ? ` <span style="color:#888">· ${s.kcal} kcal</span>` : '';
  const change = s.change
    ? `<div style="color:#666;font-size:13px;margin-top:2px">${STATUS_LABEL[s.change.status]} from <s>${esc(
        s.change.from,
      )}</s> — ${esc(s.change.error ?? s.change.reason)}</div>`
    : '';
  return `<tr><td style="padding:6px 12px 6px 0;vertical-align:top;color:#555;white-space:nowrap">${esc(
    s.slot,
  )}</td><td style="padding:6px 0">${esc(s.dish)}${kcal}${change}</td></tr>`;
}

function renderDay(day: SummaryDay, showOrder: boolean): string {
  const total = day.slots.reduce((sum, s) => sum + (s.kcal ?? 0), 0);
  const title = fmtDate(day.date, { weekday: 'long', day: 'numeric', month: 'short' });
  const meta = [showOrder ? `order #${day.orderId}` : '', total ? `${total} kcal` : '', day.locked ? '🔒' : '']
    .filter(Boolean)
    .join(' · ');
  return `<h3 style="margin:24px 0 4px">${title} <span style="font-weight:normal;color:#888;font-size:14px">${meta}</span></h3>
<table style="border-collapse:collapse;font-size:15px">${day.slots.map(renderSlot).join('')}</table>`;
}

export interface WeeklyEmail {
  subject: string;
  html: string;
}

/** Render the summary email for the days inside `week`; changes on other days are only counted. */
export function renderWeeklyEmail(
  days: SummaryDay[],
  week: { from: string; to: string },
  mode: 'apply' | 'dry-run',
): WeeklyEmail {
  const inWeek = days.filter((d) => d.date >= week.from && d.date <= week.to);
  const changesIn = (ds: SummaryDay[]) => ds.flatMap((d) => d.slots).filter((s) => s.change).length;
  const weekChanges = changesIn(inWeek);
  const otherChanges = changesIn(days.filter((d) => d.date < week.from || d.date > week.to));
  const failed = days.flatMap((d) => d.slots).filter((s) => s.change?.status === 'failed').length;
  const showOrder = new Set(days.map((d) => d.orderId)).size > 1;

  const range = `${fmtDate(week.from, { day: 'numeric', month: 'short' })} – ${fmtDate(week.to, { day: 'numeric', month: 'short' })}`;
  const verb = mode === 'apply' ? 'changed' : 'proposed';
  const subject = `🥗 Dietly menu ${range}${weekChanges ? ` (${weekChanges} ${verb})` : ''}${failed ? ` ⚠️ ${failed} failed` : ''}`;

  const notes = [
    mode === 'dry-run' ? 'Dry run — nothing was changed; 💡 marks what the model would switch.' : '',
    otherChanges ? `Also ${verb} ${otherChanges} meal(s) on days outside this week.` : '',
    inWeek.some((d) => d.locked) ? '🔒 = past the edit cutoff, shown as delivered.' : '',
  ].filter(Boolean);

  const body = inWeek.length
    ? inWeek.map((d) => renderDay(d, showOrder)).join('\n')
    : '<p>No published menu for this week yet.</p>';
  const html = `<div style="font-family:-apple-system,Segoe UI,Helvetica,Arial,sans-serif;color:#222;max-width:720px">
<h2 style="margin:0 0 8px">Your Dietly menu, ${range}</h2>
${notes.map((n) => `<p style="color:#666;margin:4px 0">${esc(n)}</p>`).join('\n')}
${body}
</div>`;
  return { subject, html };
}
