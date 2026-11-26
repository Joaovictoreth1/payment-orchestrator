import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { Pool } from "pg";
import { createPaymentServer } from "../backend/http.ts";
import {
  PostgresIdempotencyStore,
  StorageUnavailable,
} from "../backend/idempotency.ts";
import type { IdempotencyStore } from "../backend/idempotency.ts";
import { PaymentOrchestrator } from "../backend/payment_orchestrator.ts";
import type { GatewayOutcome } from "../backend/payment_orchestrator.ts";
import { processPayment } from "../backend/payments.ts";
import type { Payment } from "../backend/payment_orchestrator.ts";

const url = process.env.TEST_DATABASE_URL;
const apiKey = "postgres-fixture-key-".repeat(3);
const card = {
  amountMinor: 1250,
  method: "CREDIT_CARD",
  currency: "BRL",
  paymentToken: "tok_sim_approved",
} satisfies Payment;

test(
  "PostgreSQL arbitrates claims between replicas, replays across a restart and holds uncertain writes",
  {
    skip:
      !url && "Provide TEST_DATABASE_URL for the PostgreSQL integration test",
    timeout: 15_000,
  },
  async (t) => {
    assert.ok(url);
    const schema = "payment_test_" + randomUUID().replaceAll("-", "");
    const admin = new Pool({ connectionString: url });
    await admin.query(`CREATE SCHEMA "${schema}"`);
    t.after(async () => {
      await admin.query(`DROP SCHEMA "${schema}" CASCADE`);
      await admin.end();
    });
    const connect = () =>
      new Pool({ connectionString: url, options: `-c search_path=${schema}` });
    const poolA = connect();
    const poolB = connect();
    const poolC = connect();
    t.after(async () => {
      await Promise.all([poolB.end(), poolC.end()]);
    });
    let endedA = false;
    t.after(async () => {
      if (!endedA) await poolA.end();
    });
    const storeA = new PostgresIdempotencyStore(poolA);
    const storeB = new PostgresIdempotencyStore(poolB);
    const storeC = new PostgresIdempotencyStore(poolC);
    await assert.rejects(storeA.check());
    await assert.rejects(
      storeA.claim(randomUUID(), "f".repeat(64)),
      StorageUnavailable,
    );
    await poolA.query(
      await readFile(
        new URL(
          "../db/migrations/001_payment_idempotency.sql",
          import.meta.url,
        ),
        "utf8",
      ),
    );
    await storeA.check();

    const raceKey = randomUUID();
    const fingerprint = "a".repeat(64);
    const competingClaims = await Promise.all([
      storeA.claim(raceKey, fingerprint),
      storeB.claim(raceKey, fingerprint),
    ]);
    assert.deepEqual(competingClaims.map(({ kind }) => kind).sort(), [
      "acquired",
      "pending",
    ]);

    const entered = Promise.withResolvers<undefined>();
    const outcome = Promise.withResolvers<GatewayOutcome>();
    let gatewayCalls = 0;
    const gateway = {
      name: "fixture-primary",
      process: () => {
        gatewayCalls += 1;
        entered.resolve(undefined);
        return outcome.promise;
      },
    };

    async function start(store: IdempotencyStore) {
      const { server } = createPaymentServer({
        store,
        orchestrator: new PaymentOrchestrator([gateway], {
          timeoutMs: 5_000,
          cooldownMs: 20,
          failureThreshold: 2,
        }),
        apiKey,
        requestsPerSecond: 200,
        maxInflight: 32,
      });
      server.listen(0, "127.0.0.1");
      await once(server, "listening");
      let closed = false;
      async function close() {
        if (closed) return;
        closed = true;
        await new Promise<void>((resolve) => {
          server.close(() => {
            resolve();
          });
        });
      }
      t.after(close);
      const address = server.address();
      assert.ok(address && typeof address !== "string");
      return {
        close,
        pay: (key: string, body: Payment = card) =>
          fetch(
            `http://127.0.0.1:${address.port.toString()}/api/v1/payments/process`,
            {
              method: "POST",
              headers: {
                authorization: `Bearer ${apiKey}`,
                "content-type": "application/json",
                "idempotency-key": key,
              },
              body: JSON.stringify(body),
            },
          ),
      };
    }

    const a = await start(storeA);
    const b = await start(storeB);
    const key = randomUUID();
    const first = a.pay(key);
    await entered.promise;
    try {
      const duplicates = await Promise.all(
        Array.from({ length: 10 }, () => b.pay(key)),
      );
      for (const duplicate of duplicates) {
        assert.equal(duplicate.status, 409);
        assert.equal(duplicate.headers.get("retry-after"), "1");
        assert.match(await duplicate.text(), /PAYMENT_PENDING/);
      }
      const conflict = await b.pay(key, { ...card, amountMinor: 1 });
      assert.equal(conflict.status, 409);
      assert.match(await conflict.text(), /IDEMPOTENCY_CONFLICT/);
    } finally {
      outcome.resolve({ status: "APPROVED", transactionId: "sim_approved" });
    }
    const original = await first;
    assert.equal(original.status, 200);
    const originalBody = await original.text();
    assert.match(originalBody, /sim_approved/);
    assert.doesNotMatch(originalBody, /tok_sim|fixture-key/);
    await a.close();
    await poolA.end();
    endedA = true;

    const restarted = await start(storeC);
    const replay = await restarted.pay(key);
    assert.equal(replay.headers.get("idempotency-replayed"), "true");
    assert.equal(replay.status, 200);
    assert.equal(await replay.text(), originalBody);
    assert.equal(gatewayCalls, 1);
    const conflict = await restarted.pay(key, {
      ...card,
      paymentToken: "tok_sim_different",
    });
    assert.equal(conflict.status, 409);
    assert.match(await conflict.text(), /IDEMPOTENCY_CONFLICT/);
    assert.equal(gatewayCalls, 1);

    const brokenCompletion: IdempotencyStore = {
      check: () => storeB.check(),
      claim: (key, fingerprint) => storeB.claim(key, fingerprint),
      complete: (key, response) =>
        storeB.complete(key, { ...response, status: 201 }),
    };
    const interrupted = await start(brokenCompletion);
    const interruptedKey = randomUUID();
    const uncertain = await interrupted.pay(interruptedKey);
    assert.equal(uncertain.status, 503);
    assert.match(await uncertain.text(), /STORAGE_UNAVAILABLE/);
    const retry = await restarted.pay(interruptedKey);
    assert.equal(retry.status, 409);
    assert.match(await retry.text(), /PAYMENT_PENDING/);
    assert.equal(gatewayCalls, 2);
    await assert.rejects(
      storeC.complete(key, { status: 200, body: "{}" }),
      StorageUnavailable,
    );
  },
);

test("an unknown payment is replayed without routing another submission", async () => {
  const key = randomUUID();
  let recorded: { status: number; body: string } | undefined;
  let calls = 0;
  const orchestrator = new PaymentOrchestrator(
    [
      {
        name: "fixture",
        process: () => {
          calls += 1;
          return Promise.resolve({ status: "UNKNOWN" });
        },
      },
    ],
    { timeoutMs: 20, cooldownMs: 20, failureThreshold: 1 },
  );
  const store: IdempotencyStore = {
    claim: () =>
      Promise.resolve(
        recorded
          ? { kind: "replay", response: recorded }
          : { kind: "acquired" },
      ),
    complete: (_, response) => {
      recorded = response;
      return Promise.resolve();
    },
    check: () => Promise.resolve(),
  };
  const first = await processPayment(store, orchestrator, key, card);
  const second = await processPayment(store, orchestrator, key, card);
  assert.match(first.response.body, /UNKNOWN/);
  assert.equal(first.response.status, 503);
  assert.deepEqual(second.response, first.response);
  assert.equal(second.replayed, true);
  assert.equal(calls, 1);
});
