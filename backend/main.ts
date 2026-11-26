import { once } from "node:events";
import { Pool } from "pg";
import { loadConfig } from "./config.ts";
import { createPaymentServer } from "./http.ts";
import { PostgresIdempotencyStore } from "./idempotency.ts";
import {
  createSimulator,
  PaymentOrchestrator,
} from "./payment_orchestrator.ts";

const config = loadConfig(process.env);
const pool = new Pool({
  connectionString: config.databaseUrl,
  max: 12,
  connectionTimeoutMillis: 2_000,
  statement_timeout: 2_000,
  query_timeout: 3_000,
});
pool.on("error", () => {
  console.error(JSON.stringify({ event: "database_connection_error" }));
});

const store = new PostgresIdempotencyStore(pool);
const orchestrator = new PaymentOrchestrator(
  [createSimulator("primary"), createSimulator("fallback")],
  {
    failureThreshold: 3,
    cooldownMs: 15_000,
    timeoutMs: 2_000,
  },
);
const { server, drain } = createPaymentServer({
  ...config,
  store,
  orchestrator,
  log: (event) => {
    console.log(JSON.stringify({ event: "http_request", ...event }));
  },
});

try {
  await store.check();
  server.listen(config.port, config.host);
  await once(server, "listening");
} catch {
  await pool.end();
  throw new Error(
    "Startup failed: verify the database, migration, and listen address.",
  );
}
console.log(
  JSON.stringify({
    event: "listening",
    mode: "simulation",
    host: config.host,
    port: config.port,
  }),
);

let stopping = false;
function shutdown(): void {
  if (stopping) return;
  stopping = true;
  drain();
  const deadline = setTimeout(() => process.exit(1), 25_000);
  deadline.unref();
  server.close(() => {
    void pool.end().then(
      () => {
        clearTimeout(deadline);
      },
      () => {
        process.exitCode = 1;
      },
    );
  });
}
process.once("SIGINT", shutdown);
process.once("SIGTERM", shutdown);
