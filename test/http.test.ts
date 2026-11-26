import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { request } from "node:http";
import { test } from "node:test";
import type { TestContext } from "node:test";
import { createPaymentServer } from "../backend/http.ts";
import { StorageUnavailable } from "../backend/idempotency.ts";
import type { IdempotencyStore } from "../backend/idempotency.ts";
import {
  createSimulator,
  PaymentOrchestrator,
} from "../backend/payment_orchestrator.ts";
import type { GatewayOutcome } from "../backend/payment_orchestrator.ts";

const apiKey = "local-fixture-only-".repeat(3);
const route = "/api/v1/payments/process";
const card = {
  amountMinor: 1250,
  method: "CREDIT_CARD",
  currency: "USD",
  paymentToken: "tok_sim_approved",
};
const defaultStore: IdempotencyStore = {
  claim: () => Promise.resolve({ kind: "acquired" }),
  complete: () => Promise.resolve(),
  check: () => Promise.resolve(),
};
const gatewayOptions = {
  timeoutMs: 2_000,
  failureThreshold: 3,
  cooldownMs: 200,
};
type Overrides = Partial<Parameters<typeof createPaymentServer>[0]>;

async function start(t: TestContext, overrides: Overrides = {}) {
  const { server, drain } = createPaymentServer({
    store: defaultStore,
    orchestrator: new PaymentOrchestrator(
      [createSimulator("primary"), createSimulator("fallback")],
      gatewayOptions,
    ),
    apiKey,
    requestsPerSecond: 100,
    maxInflight: 16,
    ...overrides,
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(
    () =>
      new Promise<void>((resolve) => {
        server.close(() => {
          resolve();
        });
      }),
  );
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const base = `http://127.0.0.1:${address.port.toString()}`;
  return {
    base,
    drain,
    pay: (body: string, headers: Record<string, string> = {}) =>
      fetch(base + route, {
        method: "POST",
        headers: {
          authorization: `Bearer ${apiKey}`,
          "content-type": "application/json",
          "idempotency-key": randomUUID(),
          ...headers,
        },
        body,
      }),
  };
}

async function expectError(response: Response, status: number, code: string) {
  assert.equal(response.status, status);
  const result: unknown = await response.json();
  assert.partialDeepStrictEqual(result, { error: { code } });
  assert.match(JSON.stringify(result), /"message":"[^"]+"/);
}

test("exposes liveness, readiness, allowed methods and security headers", async (t) => {
  let ready = true;
  const { base, drain } = await start(t, {
    store: {
      ...defaultStore,
      check: () =>
        ready
          ? Promise.resolve()
          : Promise.reject(new Error("private database detail")),
    },
  });
  const health = await fetch(base + "/health");
  assert.deepEqual(await health.json(), { status: "ok" });
  assert.equal(health.headers.get("cache-control"), "no-store");
  assert.equal(health.headers.get("x-content-type-options"), "nosniff");
  assert.match(
    health.headers.get("content-security-policy") ?? "",
    /frame-ancestors 'none'/,
  );
  assert.ok(health.headers.get("x-request-id"));
  assert.equal(health.headers.get("access-control-allow-origin"), null);
  assert.deepEqual(await (await fetch(base + "/ready")).json(), {
    status: "ready",
  });
  ready = false;
  const notReady = await fetch(base + "/ready");
  assert.equal(notReady.status, 503);
  assert.deepEqual(await notReady.json(), { status: "not_ready" });
  const method = await fetch(base + route);
  assert.equal(method.headers.get("allow"), "POST");
  await expectError(method, 405, "METHOD_NOT_ALLOWED");
  await expectError(await fetch(base + "/not-a-route"), 404, "NOT_FOUND");
  drain();
  assert.equal((await fetch(base + "/ready")).status, 503);
});

test("enforces the service credential and a valid idempotency key before storage", async (t) => {
  const { base, pay } = await start(t, {
    store: {
      ...defaultStore,
      claim: () => assert.fail("request must be rejected before storage"),
    },
  });
  const missing = await fetch(base + route, { method: "POST" });
  assert.match(missing.headers.get("www-authenticate") ?? "", /^Bearer/);
  await expectError(missing, 401, "UNAUTHORIZED");
  await expectError(
    await pay(JSON.stringify(card), {
      authorization: "Bearer " + "z".repeat(40),
    }),
    401,
    "UNAUTHORIZED",
  );
  await expectError(
    await pay(JSON.stringify(card), { "idempotency-key": "too-short" }),
    400,
    "INVALID_IDEMPOTENCY_KEY",
  );
});

test("rejects oversized JSON by both declared length and streaming byte count", async (t) => {
  const { base, pay } = await start(t);
  await expectError(await pay(" ".repeat(16_385)), 413, "BODY_TOO_LARGE");
  const streamed = await new Promise<number | undefined>((resolve, reject) => {
    const req = request(
      base + route,
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${apiKey}`,
          "content-type": "application/json",
          "idempotency-key": randomUUID(),
        },
      },
      (res) => {
        res.resume();
        resolve(res.statusCode);
      },
    );
    req.on("error", reject);
    req.write(Buffer.alloc(8_192, " "));
    req.end(Buffer.alloc(8_193, " "));
  });
  assert.equal(streamed, 413);
});

test("validates media type, encoding, shape, integer amounts, and payment method fields", async (t) => {
  const { pay } = await start(t, {
    store: {
      ...defaultStore,
      claim: () => assert.fail("invalid payment must not be stored"),
    },
  });
  await expectError(
    await pay("{}", { "content-type": "text/plain" }),
    415,
    "UNSUPPORTED_MEDIA_TYPE",
  );
  await expectError(
    await pay("{}", { "content-encoding": "gzip" }),
    415,
    "UNSUPPORTED_MEDIA_TYPE",
  );
  await expectError(await pay("{"), 400, "INVALID_JSON");
  for (const body of [
    null,
    [],
    "string",
    {},
    { ...card, extra: true },
    { ...card, cardNumber: "not-a-token" },
    { ...card, amountMinor: 0 },
    { ...card, amountMinor: 0.001 },
    { ...card, amountMinor: "10" },
    { ...card, amountMinor: 1_000_000_000 },
    { ...card, currency: "GBP" },
    { ...card, method: "WIRE" },
    { ...card, paymentToken: undefined },
    { ...card, paymentToken: "not-an-opaque-token" },
    { ...card, paymentToken: "tok_1234567898765432" },
    { ...card, method: "PIX", currency: "BRL" },
    { amountMinor: 1, method: "PIX", currency: "EUR" },
  ]) {
    await expectError(await pay(JSON.stringify(body)), 400, "INVALID_PAYMENT");
  }
});

test("responds with approval, decline or unknown without disclosing credentials or tokens", async (t) => {
  const logs: unknown[] = [];
  const { pay } = await start(t, {
    log: (event) => {
      logs.push(event);
    },
  });
  for (const [status, token, outcome] of [
    [200, "tok_sim_approved", "APPROVED"],
    [402, "tok_sim_declined", "DECLINED"],
    [503, "tok_sim_unknown", "UNKNOWN"],
    [200, "tok_sim_fallback", "APPROVED"],
  ] as const) {
    const response = await pay(
      JSON.stringify({ ...card, paymentToken: token }),
      { "content-type": 'application/json; charset="utf-8"' },
    );
    assert.equal(response.status, status);
    const body = await response.text();
    assert.ok(body.includes(outcome));
    assert.ok(!body.includes(token));
  }
  assert.equal(
    (
      await pay(
        JSON.stringify({ amountMinor: 1, method: "PIX", currency: "BRL" }),
      )
    ).status,
    200,
  );
  const serializedLogs = JSON.stringify(logs);
  assert.ok(logs.length >= 5);
  assert.ok(!serializedLogs.includes("tok_sim"));
  assert.ok(!serializedLogs.includes(apiKey));
  assert.ok(!serializedLogs.includes("idempotency"));
});

test("limits authenticated requests and refills the bucket", async (t) => {
  let now = 0;
  const { pay } = await start(t, { requestsPerSecond: 1, now: () => now });
  const body = JSON.stringify(card);
  assert.equal((await pay(body)).status, 200);
  const limited = await pay(body);
  assert.equal(limited.headers.get("retry-after"), "1");
  await expectError(limited, 429, "RATE_LIMITED");
  now += 1_000;
  assert.equal((await pay(body)).status, 200);
});

test("bounds concurrent work and rejects new payments while draining", async (t) => {
  const reached = Promise.withResolvers<undefined>();
  const release = Promise.withResolvers<GatewayOutcome>();
  const orchestrator = new PaymentOrchestrator(
    [
      {
        name: "slow",
        process: () => {
          reached.resolve(undefined);
          return release.promise;
        },
      },
    ],
    gatewayOptions,
  );
  const { pay, drain } = await start(t, { maxInflight: 1, orchestrator });
  const body = JSON.stringify(card);
  const first = pay(body);
  await reached.promise;
  try {
    await expectError(await pay(body), 503, "SERVER_BUSY");
  } finally {
    release.resolve({ status: "DECLINED" });
  }
  assert.equal((await first).status, 402);
  drain();
  await expectError(await pay(body), 503, "SERVER_BUSY");
});

test("fails closed on storage faults and keeps internal errors private", async (t) => {
  let fault: Error = new StorageUnavailable("internal storage detail");
  const { pay } = await start(t, {
    store: { ...defaultStore, claim: () => Promise.reject(fault) },
    orchestrator: new PaymentOrchestrator(
      [
        {
          name: "unused",
          process: () => assert.fail("gateway must not be invoked"),
        },
      ],
      gatewayOptions,
    ),
  });
  await expectError(
    await pay(JSON.stringify(card)),
    503,
    "STORAGE_UNAVAILABLE",
  );
  fault = new Error("different internal detail");
  await expectError(await pay(JSON.stringify(card)), 500, "INTERNAL_ERROR");
});
