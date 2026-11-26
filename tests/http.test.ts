import assert from 'node:assert/strict';
import { once } from 'node:events';
import { request } from 'node:http';
import { test, type TestContext } from 'node:test';

import { createPaymentServer } from '../backend/http.ts';
import type { OrchestratorResult, PaymentOrchestrator } from '../backend/payment_orchestrator.ts';

const path = '/api/v1/payments/process';
const payment = { amount: 19.99, method: 'PIX' };
const approved: OrchestratorResult = {
  success: true, transactionId: 'sim_test', gatewayUsed: 'test', processingTimeMs: 0, retries: 0, attempts: [],
};

async function start(t: TestContext, executePayment: PaymentOrchestrator['executePayment']) {
  const server = createPaymentServer({ executePayment });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise<void>((resolve) => {
    server.close(() => resolve());
    server.closeAllConnections();
  }));
  const address = server.address();
  assert(address && typeof address !== 'string');
  return `http://127.0.0.1:${address.port}`;
}

const post = (base: string, body: unknown, key?: string) => fetch(`${base}${path}`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', ...(key !== undefined ? { 'Idempotency-Key': key } : {}) },
  body: JSON.stringify(body),
});

test('concurrent normalized requests replay one result; mismatches return 409', async (t) => {
  let calls = 0;
  const started = Promise.withResolvers<void>();
  const gate = Promise.withResolvers<OrchestratorResult>();
  const base = await start(t, async () => {
    calls += 1;
    started.resolve();
    return gate.promise;
  });
  const first = post(base, payment, 'same-key');
  await started.promise;
  const second = post(base, { ...payment, currency: 'BRL' }, 'same-key');
  const conflicting = await post(base, { ...payment, amount: 20 }, 'same-key');
  gate.resolve(approved);
  assert.equal(conflicting.status, 409);
  const replies = await Promise.all([first, second]);
  assert.deepEqual(replies.map((response) => response.status), [200, 200]);
  assert.deepEqual(await replies[0].json(), await replies[1].json());
  assert.equal((await post(base, { amount: 0, method: 'PIX' }, 'same-key')).status, 400);
  assert.equal(calls, 1);
});

test('invalid amount, method, card fields and idempotency headers never reach gateways', async (t) => {
  const base = await start(t, async () => assert.fail('Invalid request reached a gateway'));
  for (const body of [
    null, [], { ...payment, amount: 0.001 }, { ...payment, amount: 1.005 },
    { ...payment, amount: 1_000_001 }, { ...payment, currency: 'GBP' },
    { ...payment, method: 'CREDIT_CARD', cardNumber: 'unused-test-field' },
  ]) {
    assert.equal((await post(base, body)).status, 400);
  }
  assert.equal((await post(base, payment, 'invalid key')).status, 400);
  assert.equal((await fetch(`${base}${path}`, { method: 'POST', body: '{}' })).status, 415);
  assert.equal((await fetch(`${base}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: '{broken',
  })).status, 400);
});

test('fixed-length and streamed oversized bodies return 413', async (t) => {
  const base = await start(t, async () => assert.fail('Oversized request reached a gateway'));
  assert.equal((await post(base, { text: 'x'.repeat(17_000) })).status, 413);
  const status = await new Promise<number | undefined>((resolve, reject) => {
    const req = request(`${base}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
    }, (response) => {
      response.resume();
      resolve(response.statusCode);
    });
    req.on('error', reject);
    req.write('x'.repeat(15_000));
    req.end('x'.repeat(2_000));
  });
  assert.equal(status, 413);
});

test('health, business decline, technical outage and unknown routes use distinct statuses', async (t) => {
  const base = await start(t, async (input) => ({
    ...approved,
    success: false,
    errorCode: input.method === 'PIX' ? 'GATEWAY_UNAVAILABLE' : 'CARD_DECLINED',
  }));
  assert.equal((await fetch(`${base}/health`)).status, 200);
  assert.equal((await fetch(`${base}/missing`)).status, 404);
  assert.equal((await post(base, payment)).status, 503);
  assert.equal((await post(base, { ...payment, method: 'CREDIT_CARD' })).status, 402);
});
