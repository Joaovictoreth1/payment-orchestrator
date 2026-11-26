import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

const apiKey = process.env.PAYMENT_API_KEY;
assert.ok(apiKey, "Set PAYMENT_API_KEY in the environment or .env.");
const base =
  process.env.SMOKE_URL ?? `http://127.0.0.1:${process.env.PORT ?? "3000"}`;
const request = (path: string, init?: RequestInit) =>
  fetch(new URL(path, base), { ...init, signal: AbortSignal.timeout(5_000) });

assert.equal((await request("/ready")).status, 200, "Service must be ready.");
console.log("readiness: 200");

const key = randomUUID();
const payment = { amountMinor: 1250, method: "PIX", currency: "BRL" };
const pay = (amountMinor: number) =>
  request("/api/v1/payments/process", {
    method: "POST",
    headers: {
      authorization: `Bearer ${apiKey}`,
      "content-type": "application/json",
      "idempotency-key": key,
    },
    body: JSON.stringify({ ...payment, amountMinor }),
  });
const first = await pay(payment.amountMinor);
assert.equal(first.status, 200);
assert.equal(first.headers.get("idempotency-replayed"), null);
const firstBody = await first.text();
assert.match(firstBody, /"transactionId":"sim_[^"]+"/);
console.log("payment: 200, simulated transaction returned");

const replay = await pay(payment.amountMinor);
assert.equal(replay.status, 200);
assert.equal(replay.headers.get("idempotency-replayed"), "true");
assert.equal(await replay.text(), firstBody);
console.log("replay: 200, exact original outcome");

const conflict = await pay(payment.amountMinor + 1);
assert.equal(conflict.status, 409);
const error: unknown = await conflict.json();
assert.partialDeepStrictEqual(error, {
  error: { code: "IDEMPOTENCY_CONFLICT" },
});
console.log("changed payment with same key: 409");
