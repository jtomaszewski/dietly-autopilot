import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { sendEmail } from './mail.ts';

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
  delete process.env.RESEND_API_KEY;
  delete process.env.DIETLY_SUMMARY_FROM;
});

test('posts the email to Resend with the API key', async () => {
  process.env.RESEND_API_KEY = 're_test';
  process.env.DIETLY_SUMMARY_FROM = 'Dietly <dietly@example.com>';
  let call: { url: string; init: RequestInit } | undefined;
  globalThis.fetch = (async (url: string, init: RequestInit) => {
    call = { url, init };
    return new Response('{"id":"1"}', { status: 200 });
  }) as typeof fetch;

  await sendEmail('me@example.com', 'Menu', '<p>hi</p>');
  assert.equal(call!.url, 'https://api.resend.com/emails');
  assert.equal((call!.init.headers as Record<string, string>).Authorization, 'Bearer re_test');
  assert.deepEqual(JSON.parse(call!.init.body as string), {
    from: 'Dietly <dietly@example.com>',
    to: ['me@example.com'],
    subject: 'Menu',
    html: '<p>hi</p>',
  });
});

test('surfaces Resend errors and missing config', async () => {
  await assert.rejects(sendEmail('a@b.c', 's', 'h'), /RESEND_API_KEY and DIETLY_SUMMARY_FROM/);
  process.env.RESEND_API_KEY = 're_test';
  process.env.DIETLY_SUMMARY_FROM = 'x@example.com';
  globalThis.fetch = (async () => new Response('domain not verified', { status: 403 })) as unknown as typeof fetch;
  await assert.rejects(sendEmail('a@b.c', 's', 'h'), /Resend 403: domain not verified/);
});
