import assert from 'node:assert/strict';
import { test } from 'node:test';

import { HttpError, IdempotencyStore } from '../backend/idempotency.ts';
import { PaymentOrchestrator, type IPaymentGateway, type PaymentRequest, type PaymentResult } from '../backend/payment_orchestrator.ts';

const payment: PaymentRequest = { amount: 19.99, currency: 'BRL', method: 'PIX' };
const approved: PaymentResult = {
  success: true, transactionId: 'sim_test', gatewayUsed: 'fallback', processingTimeMs: 0,
};

test('an unresponsive gateway times out even when it ignores cancellation', async () => {
  const gateways: IPaymentGateway[] = [
    { name: 'stuck', process: () => new Promise(() => {}) },
    { name: 'fallback', process: async () => approved },
  ];
  const orchestrator = new PaymentOrchestrator(gateways, { timeoutMs: 10 });
  const result = await orchestrator.executePayment(payment);
  assert.equal(result.transactionId, 'sim_test');
  assert.equal(result.retries, 1);
  assert.deepEqual(result.attempts.map((attempt) => attempt.outcome), ['TECHNICAL_ERROR', 'SUCCESS']);
});

test('business declines do not open the circuit breaker', async () => {
  const declined: PaymentResult = {
    success: false, gatewayUsed: 'declined', processingTimeMs: 0, errorCode: 'CARD_DECLINED',
  };
  const orchestrator = new PaymentOrchestrator([{ name: 'declined', process: async () => declined }]);
  for (let i = 0; i < 4; i += 1) {
    const result = await orchestrator.executePayment(payment);
    assert.equal(result.errorCode, 'CARD_DECLINED');
    assert.equal(result.attempts[0].outcome, 'DECLINED');
  }
});

test('an open circuit admits one half-open probe after cooldown', async () => {
  let now = 0;
  let calls = 0;
  const probe = Promise.withResolvers<PaymentResult>();
  const orchestrator = new PaymentOrchestrator([{
    name: 'recovering',
    async process() {
      if (++calls <= 3) throw new Error('Mock technical failure');
      return probe.promise;
    },
  }], { now: () => now, cooldownMs: 100 });
  for (let i = 0; i < 3; i += 1) await orchestrator.executePayment(payment);
  assert.equal((await orchestrator.executePayment(payment)).attempts[0].outcome, 'CIRCUIT_OPEN');

  now = 100;
  const halfOpen = orchestrator.executePayment(payment);
  assert.equal((await orchestrator.executePayment(payment)).attempts[0].outcome, 'CIRCUIT_OPEN');
  probe.resolve(approved);
  assert.equal((await halfOpen).success, true);
  assert.equal((await orchestrator.executePayment(payment)).success, true);
  assert.equal(calls, 5);
});

test('idempotency capacity and TTL never evict pending entries', async () => {
  let now = 0;
  const store = new IdempotencyStore<number>(1, 10, () => now);
  const gate = Promise.withResolvers<number>();
  const first = store.run('first', 'amount=19.99', () => gate.promise);

  now = 50;
  assert.equal(store.run('first', 'amount=19.99', async () => 0), first);
  assert.throws(() => store.run('second', 'amount=19.99', async () => 0), { statusCode: 503 });
  gate.resolve(42);
  assert.equal(await first, 42);
  now = 59;
  assert.throws(() => store.run('first', 'other', async () => 0), HttpError);
  now = 60;
  assert.equal(await store.run('second', 'other', async () => 21), 21);
});

test('an unexpected rejection does not poison its idempotency key', async () => {
  const store = new IdempotencyStore<number>();
  await assert.rejects(store.run('key', 'payment', async () => { throw new Error('internal failure'); }));
  assert.equal(await store.run('key', 'payment', async () => 21), 21);
});
