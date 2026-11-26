import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import { createServer } from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import { StorageUnavailable } from "./idempotency.ts";
import type { IdempotencyStore } from "./idempotency.ts";
import type { PaymentOrchestrator } from "./payment_orchestrator.ts";
import { ApiError, parsePayment, processPayment } from "./payments.ts";

const paymentRoute = "/api/v1/payments/process";
const maxBodyBytes = 16 * 1024;
const jsonMediaType = /^application\/json(?:\s*;\s*charset\s*=\s*"?utf-8"?)?$/i;

function digest(value: string): Buffer {
  return createHash("sha256").update(value).digest();
}

function singleHeader(req: IncomingMessage, name: string): string | undefined {
  const values = req.headersDistinct[name];
  return values?.length === 1 ? values[0] : undefined;
}

async function readBody(req: IncomingMessage): Promise<unknown> {
  if (
    !jsonMediaType.test(singleHeader(req, "content-type") ?? "") ||
    req.headersDistinct["content-encoding"] !== undefined
  ) {
    throw new ApiError(
      415,
      "UNSUPPORTED_MEDIA_TYPE",
      "Send uncompressed application/json.",
    );
  }
  if (Number(req.headers["content-length"]) > maxBodyBytes) {
    throw new ApiError(
      413,
      "BODY_TOO_LARGE",
      "JSON body must be at most 16 KiB.",
    );
  }
  const chunks: Uint8Array[] = [];
  let size = 0;
  for await (const chunk of req.iterator({
    destroyOnReturn: false,
  }) as AsyncIterable<Buffer>) {
    size += chunk.byteLength;
    if (size > maxBodyBytes) {
      throw new ApiError(
        413,
        "BODY_TOO_LARGE",
        "JSON body must be at most 16 KiB.",
      );
    }
    chunks.push(chunk);
  }
  try {
    return JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks)),
    ) as unknown;
  } catch {
    throw new ApiError(
      400,
      "INVALID_JSON",
      "Send a valid UTF-8 JSON document.",
    );
  }
}

function send(res: ServerResponse, status: number, body: string): void {
  if (res.destroyed) return;
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(body),
  });
  res.end(body);
}

function sendError(
  req: IncomingMessage,
  res: ServerResponse,
  error: ApiError,
): void {
  if (!req.readableEnded) res.setHeader("Connection", "close");
  send(
    res,
    error.status,
    JSON.stringify({ error: { code: error.code, message: error.message } }),
  );
}

interface RequestLog {
  requestId: string;
  route: "health" | "readiness" | "payment" | "other";
  status: number;
  durationMs: number;
}

interface Options {
  apiKey: string;
  requestsPerSecond: number;
  maxInflight: number;
  store: IdempotencyStore;
  orchestrator: PaymentOrchestrator;
  log?: (event: RequestLog) => void;
  now?: () => number;
}

export function createPaymentServer(options: Options) {
  const expectedKey = digest(options.apiKey);
  const now = options.now ?? (() => performance.now());
  let draining = false;
  let inflight = 0;
  let allowance = options.requestsPerSecond;
  let lastRefill = now();

  function takeRateLimitToken(): boolean {
    const current = now();
    allowance = Math.min(
      options.requestsPerSecond,
      allowance + ((current - lastRefill) * options.requestsPerSecond) / 1_000,
    );
    lastRefill = current;
    if (allowance < 1) return false;
    allowance -= 1;
    return true;
  }

  async function readiness(res: ServerResponse): Promise<void> {
    try {
      if (!draining) {
        await options.store.check();
        send(res, 200, '{"status":"ready"}');
        return;
      }
    } catch {
      // Failure details stay private.
    }
    send(res, 503, '{"status":"not_ready"}');
  }

  async function handle(
    req: IncomingMessage,
    res: ServerResponse,
  ): Promise<void> {
    const started = now();
    const requestId = randomUUID();
    const route =
      req.url === "/health"
        ? "health"
        : req.url === "/ready"
          ? "readiness"
          : req.url === paymentRoute
            ? "payment"
            : "other";
    res.setHeader("X-Request-Id", requestId);
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader(
      "Content-Security-Policy",
      "default-src 'none'; frame-ancestors 'none'",
    );
    if (options.log) {
      res.once("finish", () =>
        options.log?.({
          requestId,
          route,
          status: res.statusCode,
          durationMs: Math.round(now() - started),
        }),
      );
    }

    try {
      if (route === "other")
        throw new ApiError(404, "NOT_FOUND", "Route not found.");
      const allowedMethod = route === "payment" ? "POST" : "GET";
      if (req.method !== allowedMethod) {
        res.setHeader("Allow", allowedMethod);
        throw new ApiError(405, "METHOD_NOT_ALLOWED", "Method not allowed.");
      }
      if (route === "health") {
        send(res, 200, '{"status":"ok"}');
        return;
      }
      if (route === "readiness") {
        await readiness(res);
        return;
      }
      const authorization = singleHeader(req, "authorization");
      const suppliedKey = /^Bearer ([A-Za-z0-9_-]{32,128})$/i.exec(
        authorization ?? "",
      )?.[1];
      if (!suppliedKey || !timingSafeEqual(expectedKey, digest(suppliedKey))) {
        res.setHeader("WWW-Authenticate", 'Bearer realm="payments"');
        throw new ApiError(
          401,
          "UNAUTHORIZED",
          "A valid bearer credential is required.",
        );
      }
      if (draining || inflight >= options.maxInflight) {
        res.setHeader("Retry-After", "1");
        throw new ApiError(
          503,
          "SERVER_BUSY",
          "Service busy; retry with the same idempotency key.",
        );
      }
      if (!takeRateLimitToken()) {
        res.setHeader("Retry-After", "1");
        throw new ApiError(429, "RATE_LIMITED", "Too many requests.");
      }
      const key = singleHeader(req, "idempotency-key");
      if (!key || !/^[A-Za-z0-9_-]{16,128}$/.test(key)) {
        throw new ApiError(
          400,
          "INVALID_IDEMPOTENCY_KEY",
          "Send a unique 16 to 128 character Idempotency-Key.",
        );
      }
      inflight += 1;
      try {
        const payment = parsePayment(await readBody(req));
        const { response, replayed } = await processPayment(
          options.store,
          options.orchestrator,
          key,
          payment,
        );
        if (replayed) res.setHeader("Idempotency-Replayed", "true");
        send(res, response.status, response.body);
      } finally {
        inflight -= 1;
      }
    } catch (error) {
      if (error instanceof ApiError) {
        if (error.code === "PAYMENT_PENDING") res.setHeader("Retry-After", "1");
        sendError(req, res, error);
      } else if (error instanceof StorageUnavailable) {
        res.setHeader("Retry-After", "1");
        sendError(
          req,
          res,
          new ApiError(
            503,
            "STORAGE_UNAVAILABLE",
            "Storage unavailable; retry with the same idempotency key.",
          ),
        );
      } else {
        sendError(
          req,
          res,
          new ApiError(500, "INTERNAL_ERROR", "Unexpected server error."),
        );
      }
    }
  }

  const server = createServer(
    {
      maxHeaderSize: 8 * 1024,
      headersTimeout: 5_000,
      requestTimeout: 10_000,
      keepAliveTimeout: 5_000,
      connectionsCheckingInterval: 1_000,
    },
    (req, res) => {
      void handle(req, res).catch(() => res.destroy());
    },
  );
  server.maxConnections = 256;
  return {
    server,
    drain: () => {
      draining = true;
    },
  };
}
