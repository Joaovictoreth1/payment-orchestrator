export interface Config {
  host: string;
  port: number;
  apiKey: string;
  databaseUrl: string;
  requestsPerSecond: number;
  maxInflight: number;
}

function positiveInteger(
  value: string | undefined,
  key: string,
  fallback: number,
  max: number,
): number {
  if (value === undefined) return fallback;
  const number = Number(value);
  if (
    !/^\d+$/.test(value) ||
    !Number.isSafeInteger(number) ||
    number < 1 ||
    number > max
  ) {
    throw new Error(`${key} must be an integer from 1 to ${String(max)}.`);
  }
  return number;
}

function databaseUrl(value: string | undefined): string {
  const parsed = URL.parse(value ?? "");
  if (
    !value ||
    !parsed ||
    !["postgres:", "postgresql:"].includes(parsed.protocol) ||
    !parsed.hostname ||
    parsed.pathname.length <= 1
  ) {
    throw new Error(
      "DATABASE_URL must be a PostgreSQL URL with a host and database.",
    );
  }
  const sslMode = parsed.searchParams.get("sslmode");
  if (sslMode !== "disable" && sslMode !== "verify-full") {
    throw new Error(
      "Set sslmode=verify-full for remote PostgreSQL, or sslmode=disable on an isolated local network.",
    );
  }
  return value;
}

export function loadConfig(env: NodeJS.ProcessEnv): Config {
  if (env.PAYMENT_MODE !== "simulation") {
    throw new Error(
      "Set PAYMENT_MODE=simulation. Live processing is not supported.",
    );
  }
  if (
    !env.PAYMENT_API_KEY ||
    !/^[A-Za-z0-9_-]{32,128}$/.test(env.PAYMENT_API_KEY)
  ) {
    throw new Error(
      "PAYMENT_API_KEY must be a random, URL-safe secret of 32 to 128 characters.",
    );
  }
  const host = env.HOST ?? "127.0.0.1";
  if (!/^[a-zA-Z0-9.:_-]+$/.test(host))
    throw new Error("HOST must be a hostname or IP address.");
  return {
    host,
    port: positiveInteger(env.PORT, "PORT", 3000, 65_535),
    apiKey: env.PAYMENT_API_KEY,
    databaseUrl: databaseUrl(env.DATABASE_URL),
    requestsPerSecond: positiveInteger(
      env.PAYMENT_REQUESTS_PER_SECOND,
      "PAYMENT_REQUESTS_PER_SECOND",
      30,
      1_000,
    ),
    maxInflight: positiveInteger(
      env.PAYMENT_MAX_INFLIGHT,
      "PAYMENT_MAX_INFLIGHT",
      32,
      256,
    ),
  };
}
