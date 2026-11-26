import assert from "node:assert/strict";
import { test } from "node:test";
import { loadConfig } from "../backend/config.ts";

const simulation = {
  PAYMENT_MODE: "simulation",
  PAYMENT_API_KEY: "a".repeat(64),
  DATABASE_URL: "postgres://localhost/payments?sslmode=disable",
};

test("requires an explicit simulation mode, valid secret, and a Postgres TLS policy", () => {
  assert.throws(() => loadConfig({}), /PAYMENT_MODE/);
  assert.throws(
    () => loadConfig({ ...simulation, PAYMENT_MODE: "live" }),
    /Live processing/,
  );
  assert.throws(
    () => loadConfig({ ...simulation, PAYMENT_API_KEY: "short" }),
    /PAYMENT_API_KEY/,
  );
  for (const url of [
    "https://db/payments",
    "postgres:///payments",
    "postgres://db",
    "secret-not-a-url",
  ]) {
    assert.throws(() => loadConfig({ ...simulation, DATABASE_URL: url }), {
      message: /DATABASE_URL/,
    });
  }
  assert.throws(
    () =>
      loadConfig({
        ...simulation,
        DATABASE_URL: "postgres://db/payment?sslmode=require",
      }),
    /verify-full/,
  );
  assert.throws(
    () => loadConfig({ ...simulation, DATABASE_URL: "postgres://db/payment" }),
    /verify-full/,
  );
});

test("validates bounded integer settings and binds to loopback by default", () => {
  for (const PORT of [
    "",
    "0",
    "-1",
    "65536",
    "1e3",
    "1.5",
    "9007199254740992",
  ]) {
    assert.throws(() => loadConfig({ ...simulation, PORT }), /PORT/);
  }
  assert.throws(() => loadConfig({ ...simulation, HOST: "bad host" }), /HOST/);
  assert.throws(
    () => loadConfig({ ...simulation, PAYMENT_REQUESTS_PER_SECOND: "1001" }),
    /PAYMENT_REQUESTS_PER_SECOND/,
  );
  assert.throws(
    () => loadConfig({ ...simulation, PAYMENT_MAX_INFLIGHT: "257" }),
    /PAYMENT_MAX_INFLIGHT/,
  );
  assert.deepEqual(loadConfig(simulation), {
    host: "127.0.0.1",
    port: 3000,
    apiKey: simulation.PAYMENT_API_KEY,
    databaseUrl: simulation.DATABASE_URL,
    requestsPerSecond: 30,
    maxInflight: 32,
  });
  assert.equal(loadConfig({ ...simulation, PORT: "8080" }).port, 8080);
  assert.equal(
    loadConfig({
      ...simulation,
      DATABASE_URL: "postgresql://remote/payments?sslmode=verify-full",
    }).port,
    3000,
  );
});
