#!/usr/bin/env node
/**
 * Reproduce the preference analysis from a Google Takeout mbox export of Dietly
 * "Potwierdzenie zmiany posiłku" (meal-change confirmation) emails.
 *
 *   node scripts/analyze-mbox.ts path/to/dietly.mbox
 *
 * Each email records: switched AWAY from dish X, TOWARD dish Y. We count, per
 * keyword group, how often it appears in the "from" set (avoided) vs the "to" set
 * (chosen). net = to - from. Strong negative = you avoid it; positive = you seek it.
 *
 * No external dependencies — minimal quoted-printable / mbox parsing inline.
 */
import { readFileSync } from 'node:fs';

function decodeQuotedPrintable(s: string): string {
  const bytes: number[] = [];
  for (let i = 0; i < s.length; i++) {
    const c = s[i]!;
    if (c === '=') {
      const hex = s.slice(i + 1, i + 3);
      if (/^[0-9A-Fa-f]{2}$/.test(hex)) {
        bytes.push(parseInt(hex, 16));
        i += 2;
      } else if (hex.startsWith('\n') || hex.startsWith('\r')) {
        // soft line break
        i += hex.startsWith('\r\n') ? 2 : 1;
      }
    } else {
      bytes.push(c.charCodeAt(0) & 0xff);
    }
  }
  return Buffer.from(bytes).toString('utf8');
}

interface Change {
  date: string;
  slot: string;
  from: string;
  to: string;
}

function extractTextPlain(message: string): string {
  // Find a text/plain part; decode if quoted-printable.
  const idx = message.indexOf('Content-Type: text/plain');
  if (idx < 0) return '';
  const after = message.slice(idx);
  const bodyStart = after.indexOf('\n\n');
  if (bodyStart < 0) return '';
  let body = after.slice(bodyStart + 2);
  const boundaryEnd = body.indexOf('\n--');
  if (boundaryEnd >= 0) body = body.slice(0, boundaryEnd);
  // Detect quoted-printable from the body itself (the CTE header isn't always adjacent).
  const isQP = /=\n/.test(body) || /=[0-9A-Fa-f]{2}/.test(body);
  return isQP ? decodeQuotedPrintable(body) : body;
}

function parseChange(message: string): Change | null {
  const t = extractTextPlain(message).replace(/\s+/g, ' ').trim();
  const grab = (a: string, b: string): string | null => {
    const m = t.match(new RegExp(`${a}\\s*(.*?)\\s*${b}`));
    return m ? m[1]!.trim() : null;
  };
  const date = grab('Data:', 'Posiłek:');
  const slot = grab('Posiłek:', 'Zmieniono z:');
  const from = grab('Zmieniono z:', 'Zmieniono na:');
  const to = grab('Zmieniono na:', 'Masz pytanie');
  if (!date || !slot) return null;
  return { date, slot, from: from ?? '', to: to ?? '' };
}

function dish(s: string): string {
  return s
    .replace(/^Wybór menu \d+ kcal,\s*/, '')
    .replace(/\s*\d+ kcal$/, '')
    .trim()
    .toLowerCase();
}

const GROUPS: Record<string, string[]> = {
  'vege/vegan cheese': ['wegańska feta', 'wegańską fetą', 'serek z orzech', 'z nerkowca'],
  'vege/soy meat': ['kotlet sojow', 'kotletami sojow', 'tofu', 'seitan'],
  'sweet porridge breakfast': ['owsiank', 'jaglank', 'jaglan', 'manna', 'budyń', 'ryżank'],
  'goulash/stew': ['gulasz', 'potrawka'],
  'egg-based': ['omlet', 'frittat', 'jajeczn'],
  chicken: ['kurczak'],
  fish: ['łoso', 'makrel', 'dorsz', 'tuńczyk', 'ryb', 'śledź'],
  pasta: ['makaron', 'spaghetti'],
  beef: ['wołow'],
  pork: ['wieprz', 'schab', 'boczek'],
  'shake/smoothie': ['koktajl', 'smoothie', 'shake'],
};

function main(): void {
  const path = process.argv[2];
  if (!path) {
    console.error('Usage: node scripts/analyze-mbox.ts <path-to.mbox>');
    process.exit(1);
  }
  const raw = readFileSync(path, 'utf8').replace(/\r\n/g, '\n');
  const messages = raw.split(/\nFrom /).map((m, i) => (i === 0 ? m : 'From ' + m));
  const changes = messages.map(parseChange).filter((c): c is Change => c !== null);

  console.log(`Parsed ${changes.length} meal changes.\n`);
  const froms = changes.map((c) => dish(c.from));
  const tos = changes.map((c) => dish(c.to));
  const count = (hay: string[], kws: string[]) =>
    hay.filter((h) => kws.some((k) => h.includes(k))).length;

  console.log('group'.padEnd(28) + 'from(avoid)'.padStart(12) + 'to(chose)'.padStart(11) + 'net'.padStart(7));
  for (const [label, kws] of Object.entries(GROUPS)) {
    const f = count(froms, kws);
    const t = count(tos, kws);
    const net = t - f;
    console.log(
      label.padEnd(28) +
        String(f).padStart(12) +
        String(t).padStart(11) +
        (net >= 0 ? `+${net}` : `${net}`).padStart(7),
    );
  }
}

main();
