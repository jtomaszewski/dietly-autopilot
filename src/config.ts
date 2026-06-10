import { readFileSync } from 'node:fs';

export interface Config {
  email: string;
  password: string;
  companyId: string;
  horizonDays: number;
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
  return {
    email,
    password,
    companyId: process.env.DIETLY_COMPANY_ID ?? 'wybormenu',
    horizonDays: Number(process.env.DIETLY_HORIZON_DAYS ?? '14'),
  };
}
