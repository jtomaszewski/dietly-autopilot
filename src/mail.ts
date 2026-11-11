/**
 * Send an HTML email through Resend's HTTP API (plain fetch, no dependency).
 * Needs RESEND_API_KEY and DIETLY_SUMMARY_FROM — an address on a domain verified in Resend.
 */
export async function sendEmail(to: string, subject: string, html: string): Promise<void> {
  const apiKey = process.env.RESEND_API_KEY;
  const from = process.env.DIETLY_SUMMARY_FROM;
  if (!apiKey || !from) {
    throw new Error('Emailing needs RESEND_API_KEY and DIETLY_SUMMARY_FROM (see .env.example).');
  }
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ from, to: [to], subject, html }),
  });
  if (!res.ok) throw new Error(`Resend ${res.status}: ${await res.text()}`);
}
