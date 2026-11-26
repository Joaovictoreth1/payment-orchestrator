import assert from "node:assert/strict";
import { test } from "node:test";
import {
  createSimulator,
  PaymentOrchestrator,
} from "../backend/payment_orchestrator.ts";
import type {
  GatewayOutcome,
  PaymentCommand,
  PaymentGateway,
} from "../backend/payment_orchestrator.ts";

const payment = {
  method: "CREDIT_CARD",
  amountMinor: 100,
  currency: "BRL",
  paymentToken: "tok_sim_approved",
  idempotencyKey: "request-12345678",
} satisfies PaymentCommand;
const approved = {
  status: "APPROVED",
  transactionId: "sim_reference",
} satisfies GatewayOutcome;
const options = { timeoutMs: 100, failureThreshold: 2, cooldownMs: 10 };
const gateway = (name: string, outcome: GatewayOutcome): PaymentGateway => ({
  name,
  process: () => Promise.resolve(outcome),
});

test("stops after an issuer decline, without sending a second payment", async () => {
  const primary = gateway("primary", { status: "DECLINED" });
  const fallback = {
    name: "fallback",
    process: () =>
      assert.fail("issuer decline must not trigger another gateway"),
  };
  assert.deepEqual(
    await new PaymentOrchestrator([primary, fallback], options).execute(
      payment,
    ),
    {
      status: "DECLINED",
      gateway: "primary",
      attempts: [{ gateway: "primary", outcome: "DECLINED" }],
    },
  );
});

test("falls back only when the first gateway confirms no submission", async () => {
  const primary = gateway("primary", { status: "NOT_SUBMITTED" });
  const fallback = gateway("fallback", approved);
  assert.deepEqual(
    await new PaymentOrchestrator([primary, fallback], options).execute(
      payment,
    ),
    {
      ...approved,
      gateway: "fallback",
      attempts: [
        { gateway: "primary", outcome: "NOT_SUBMITTED" },
        { gateway: "fallback", outcome: "APPROVED" },
      ],
    },
  );
  const unavailable = await new PaymentOrchestrator([primary], options).execute(
    payment,
  );
  assert.equal(unavailable.status, "UNAVAILABLE");
  assert.equal(unavailable.gateway, null);
});

test("bounds a non-cooperative gateway and never fails over an unknown payment", async () => {
  let signal: AbortSignal | undefined;
  const primary: PaymentGateway = {
    name: "primary",
    process: (_, received) => {
      signal = received;
      return new Promise(() => {});
    },
  };
  const fallback = {
    name: "fallback",
    process: () => assert.fail("timeout outcome is unknown"),
  };
  const result = await new PaymentOrchestrator([primary, fallback], {
    ...options,
    timeoutMs: 5,
  }).execute(payment);
  assert.equal(result.status, "UNKNOWN");
  assert.ok(signal?.aborted);
  assert.deepEqual(result.attempts, [
    { gateway: "primary", outcome: "UNKNOWN" },
  ]);
});

test("treats adapter errors as unknown without exposing diagnostic strings", async () => {
  const primary = {
    name: "primary",
    process: () => Promise.reject(new Error("private provider details")),
  };
  const result = await new PaymentOrchestrator([primary], options).execute(
    payment,
  );
  assert.deepEqual(result, {
    status: "UNKNOWN",
    gateway: "primary",
    attempts: [{ gateway: "primary", outcome: "UNKNOWN" }],
  });
});

test("opens after consecutive failures, permits one probe, and ignores stale completions", async () => {
  const stale = Promise.withResolvers<GatewayOutcome>();
  const probe = Promise.withResolvers<GatewayOutcome>();
  const next = [
    stale.promise,
    Promise.resolve({ status: "NOT_SUBMITTED" } as const),
    Promise.resolve({ status: "NOT_SUBMITTED" } as const),
    probe.promise,
    Promise.resolve(approved),
  ];
  let now = 0;
  const primary = {
    name: "primary",
    process: () => next.shift() ?? assert.fail("unexpected attempt"),
  };
  const engine = new PaymentOrchestrator(
    [primary, gateway("fallback", approved)],
    { ...options, now: () => now },
  );
  const staleRequest = engine.execute(payment);
  await engine.execute(payment);
  await engine.execute(payment);
  stale.resolve(approved);
  assert.equal((await staleRequest).gateway, "primary");
  assert.equal(
    (await engine.execute(payment)).attempts[0]?.outcome,
    "CIRCUIT_OPEN",
  );
  now += 10;
  const probeRequest = engine.execute(payment);
  assert.equal((await engine.execute(payment)).gateway, "fallback");
  probe.resolve(approved);
  assert.equal((await probeRequest).gateway, "primary");
  assert.equal((await engine.execute(payment)).gateway, "primary");
});

test("reopens a failed half-open probe instead of immediately retrying", async () => {
  let now = 0;
  const engine = new PaymentOrchestrator(
    [gateway("primary", { status: "NOT_SUBMITTED" })],
    {
      ...options,
      failureThreshold: 1,
      now: () => now,
    },
  );
  await engine.execute(payment);
  now = 10;
  assert.equal(
    (await engine.execute(payment)).attempts[0]?.outcome,
    "NOT_SUBMITTED",
  );
  assert.equal(
    (await engine.execute(payment)).attempts[0]?.outcome,
    "CIRCUIT_OPEN",
  );
});

test("a healthy decline resets the count of consecutive technical failures", async () => {
  const outcomes: GatewayOutcome[] = [
    { status: "NOT_SUBMITTED" },
    { status: "DECLINED" },
    { status: "NOT_SUBMITTED" },
    approved,
  ];
  const engine = new PaymentOrchestrator(
    [
      {
        name: "primary",
        process: () =>
          Promise.resolve(
            outcomes.shift() ?? assert.fail("unexpected attempt"),
          ),
      },
    ],
    options,
  );
  for (const status of ["UNAVAILABLE", "DECLINED", "UNAVAILABLE", "APPROVED"]) {
    assert.equal((await engine.execute(payment)).status, status);
  }
});

test("requires a distinct, non-empty gateway list", () => {
  assert.throws(() => new PaymentOrchestrator([], options), /at least one/);
  const primary = gateway("primary", approved);
  assert.throws(
    () => new PaymentOrchestrator([primary, primary], options),
    /unique/,
  );
});

test("exercises deterministic simulator outcomes without a live payment provider", async () => {
  const engine = new PaymentOrchestrator(
    [createSimulator("primary"), createSimulator("fallback")],
    options,
  );
  assert.equal((await engine.execute(payment)).status, "APPROVED");
  assert.equal(
    (await engine.execute({ ...payment, paymentToken: "tok_sim_declined" }))
      .status,
    "DECLINED",
  );
  assert.equal(
    (await engine.execute({ ...payment, paymentToken: "tok_sim_fallback" }))
      .gateway,
    "simulator-fallback",
  );
  assert.equal(
    (await engine.execute({ ...payment, paymentToken: "tok_sim_unknown" }))
      .status,
    "UNKNOWN",
  );
  assert.equal(
    (
      await engine.execute({
        amountMinor: 100,
        currency: "BRL",
        method: "PIX",
        idempotencyKey: payment.idempotencyKey,
      })
    ).status,
    "APPROVED",
  );
});
