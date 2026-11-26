import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { PaymentRequest } from '../backend/payment_orchestrator.ts';
import { addHistory, filterHistory, parseAmount, requestSimulation } from '../frontend/simulation.ts';

const payment: PaymentRequest = { amount: 25, currency: 'BRL', method: 'PIX' };
const approved = {
  message: 'Pagamento Aprovado!',
  data: { success: true, gatewayUsed: 'mock', processingTimeMs: 25, retries: 0, attempts: [] },
};
const unavailable = {
  message: 'Pagamento Recusado.',
  data: { ...approved.data, success: false, errorCode: 'GATEWAY_UNAVAILABLE' as const },
};

test('amount supports comma or dot decimal without accepting ambiguous notation', () => {
  for (const [text, expected] of [[' 25,01 ', 25.01], ['1.2', 1.2], ['1000000,00', 1_000_000], ['0,01', 0.01]] as const) {
    assert.equal(parseAmount(text), expected, text);
  }
  for (const value of ['', '0', '-1', '1e3', '1.000,00', '1000000.01', '1.005', '0x10', 'Infinity']) {
    assert.equal(parseAmount(value), null, value);
  }
});

test('uncertain transport responses can replay the original payment and key', async () => {
  const sent: unknown[] = [];
  const request: typeof fetch = async (url, init) => {
    sent.push([url, init?.method, new Headers(init?.headers).get('Idempotency-Key'), init?.body]);
    if (sent.length === 1) throw new TypeError('Connection interrupted');
    return Response.json(approved, { status: 200 });
  };
  const uncertain = await requestSimulation(payment, 'attempt-1', request);
  assert.ok('error' in uncertain && uncertain.retryable);
  assert.match(uncertain.error, /Tente novamente/);
  assert.deepEqual(await requestSimulation(payment, 'attempt-1', request), approved);
  const envelope = ['/api/v1/payments/process', 'POST', 'attempt-1', JSON.stringify(payment)];
  assert.deepEqual(sent, [envelope, envelope]);
});

test('structured decline and gateway outage are results rather than transport failures', async () => {
  const declined = { ...approved, data: { ...approved.data, success: false } };
  assert.deepEqual(await requestSimulation(payment, 'key', async () => Response.json(declined, { status: 402 })), declined);
  assert.deepEqual(await requestSimulation(payment, 'key', async () => Response.json(unavailable, { status: 503 })), unavailable);
});

test('malformed or unexpected server responses remain retryable; known request errors do not', async () => {
  for (const response of [
    new Response('<html></html>', { status: 502 }),
    Response.json(approved, { status: 500 }),
    Response.json({ ...approved, data: { ...approved.data, attempts: null } }),
  ]) {
    const result = await requestSimulation(payment, 'key', async () => response);
    assert.ok('retryable' in result && result.retryable);
  }
  const result = await requestSimulation(payment, 'key', async () =>
    Response.json({ error: 'Invalid request' }, { status: 400 }));
  assert.deepEqual(result, { error: 'Invalid request', retryable: false });
});

test('history is newest-first, bounded, deduplicated and filterable by status and method', () => {
  const entries = Array.from({ length: 26 }, (_, index) => ({
    id: String(index),
    time: index,
    payment: index % 2 ? payment : { ...payment, method: 'CREDIT_CARD' as const },
    result: index < 24 ? approved : unavailable,
  }));
  const history = entries.reduce<ReturnType<typeof addHistory>>(addHistory, []);
  assert.equal(history.length, 25);
  assert.equal(history[0].id, '25');
  assert.ok(!history.some(({ id }) => id === '0'));
  assert.deepEqual(addHistory(history, entries[24]).slice(0, 2).map(({ id }) => id), ['24', '25']);
  assert.deepEqual(filterHistory(history, 'unavailable', 'PIX').map(({ id }) => id), ['25']);
  assert.equal(filterHistory(history, 'approved', 'all').length, 23);
  assert.equal(filterHistory(history, 'declined', 'all').length, 0);
});
