/**
 * Send an HTML email through the Google Workspace CLI (`gws gmail +send`), keeping the project
 * dependency-free. Needs `gws auth login` with the gmail.send scope; override the binary via GWS_BIN.
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

export async function sendEmail(to: string, subject: string, html: string): Promise<void> {
  const bin = process.env.GWS_BIN ?? 'gws';
  await promisify(execFile)(bin, ['gmail', '+send', '--to', to, '--subject', subject, '--body', html, '--html']);
}
