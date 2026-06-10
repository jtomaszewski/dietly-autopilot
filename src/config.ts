import { readFileSync } from 'node:fs';

export interface Config {
  email: string;
  password: string;
  companyId: string;
  horizonDays: number;
  openRouterApiKey: string;
  model: string;
  /** The guidelines markdown, read from disk, handed verbatim to the model. */
  guidelines: string;
}

/** Minimal .env loader (no dependency). Existing process.env wins. */
function loadDotEnv(path = '.env'): void {
  let txt: string;
  try {
    txt = readFileSync(path, 'utf8');
  } catch {
    return;
  }
  for (const line of txt.split('\n')) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (m && m[1] && !(m[1] in process.env)) {
      process.env[m[1]] = m[2]!.replace(/^["']|["']$/g, '');
    }
  }
}

export function loadConfig(): Config {
  loadDotEnv();
  const email = process.env.DIETLY_EMAIL;
  const password = process.env.DIETLY_PASSWORD;
  if (!email || !password) {
    throw new Error(
      'Missing credentials. Set DIETLY_EMAIL and DIETLY_PASSWORD (copy .env.example to .env).',
    );
  }
  const openRouterApiKey = process.env.OPENROUTER_API_KEY;
  if (!openRouterApiKey) {
    throw new Error('Missing OPENROUTER_API_KEY (the model makes the meal decisions). See .env.example.');
  }

  const guidelinesPath = process.env.DIETLY_GUIDELINES_PATH ?? 'GUIDELINES.md';
  let guidelines: string;
  try {
    guidelines = readFileSync(guidelinesPath, 'utf8');
  } catch {
    throw new Error(`Could not read guidelines file at "${guidelinesPath}". Set DIETLY_GUIDELINES_PATH or create GUIDELINES.md.`);
  }

  return {
    email,
    password,
    companyId: process.env.DIETLY_COMPANY_ID ?? 'wybormenu',
    horizonDays: Number(process.env.DIETLY_HORIZON_DAYS ?? '14'),
    openRouterApiKey,
    model: process.env.OPENROUTER_MODEL ?? 'google/gemini-2.5-flash',
    guidelines,
  };
}
