import { createHash } from "node:crypto";
import type { IdempotencyStore, StoredResponse } from "./idempotency.ts";
import type {
  Payment,
  PaymentOrchestrator,
  PaymentResult,
} from "./payment_orchestrator.ts";

export class ApiError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

const invalid = (message: string) =>
  new ApiError(400, "INVALID_PAYMENT", message);
const fields = new Set(["amountMinor", "method", "currency", "paymentToken"]);

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function parsePayment(value: unknown): Payment {
  if (!isObject(value) || Object.keys(value).some((key) => !fields.has(key))) {
    throw invalid("Expected a payment object with only documented fields.");
  }
  const { amountMinor, method, currency, paymentToken } = value;
  if (
    typeof amountMinor !== "number" ||
    !Number.isSafeInteger(amountMinor) ||
    amountMinor < 1 ||
    amountMinor > 999_999_999
  ) {
    throw invalid("amountMinor must be an integer from 1 to 999999999.");
  }
  if (currency !== "BRL" && currency !== "USD" && currency !== "EUR") {
    throw invalid("currency must be BRL, USD, or EUR.");
  }
  if (method === "PIX") {
    if (currency !== "BRL" || Object.hasOwn(value, "paymentToken")) {
      throw invalid("PIX requires BRL and must not include a payment token.");
    }
    return { amountMinor, method, currency };
  }
  if (
    method !== "CREDIT_CARD" ||
    typeof paymentToken !== "string" ||
    !/^tok_[A-Za-z0-9_-]{8,200}$/.test(paymentToken) ||
    /^tok_\d+$/.test(paymentToken)
  ) {
    throw invalid("CREDIT_CARD requires an opaque tok_ payment token.");
  }
  return { amountMinor, method, currency, paymentToken };
}

const statuses: Record<PaymentResult["status"], number> = {
  APPROVED: 200,
  DECLINED: 402,
  UNKNOWN: 503,
  UNAVAILABLE: 503,
};

export async function processPayment(
  store: IdempotencyStore,
  orchestrator: PaymentOrchestrator,
  key: string,
  payment: Payment,
): Promise<{ response: StoredResponse; replayed: boolean }> {
  const fingerprint = createHash("sha256")
    .update(
      JSON.stringify([
        payment.amountMinor,
        payment.method,
        payment.currency,
        payment.method === "CREDIT_CARD" ? payment.paymentToken : null,
      ]),
    )
    .digest("hex");
  const claim = await store.claim(key, fingerprint);
  switch (claim.kind) {
    case "replay":
      return { response: claim.response, replayed: true };
    case "conflict":
      throw new ApiError(
        409,
        "IDEMPOTENCY_CONFLICT",
        "Use a different key for a different payment.",
      );
    case "pending":
      throw new ApiError(
        409,
        "PAYMENT_PENDING",
        "Retry this payment with the same key. Do not submit it under another key.",
      );
    case "acquired": {
      const result = await orchestrator.execute({
        ...payment,
        idempotencyKey: key,
      });
      const response = {
        status: statuses[result.status],
        body: JSON.stringify({ data: result }),
      };
      await store.complete(key, response);
      return { response, replayed: false };
    }
  }
}
