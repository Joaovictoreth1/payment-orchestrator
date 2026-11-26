import { randomUUID } from "node:crypto";

export type Currency = "BRL" | "USD" | "EUR";
export type Payment = Readonly<
  { amountMinor: number } & (
    | { method: "PIX"; currency: "BRL" }
    | { method: "CREDIT_CARD"; currency: Currency; paymentToken: string }
  )
>;
export type PaymentCommand = Payment & { readonly idempotencyKey: string };

export type GatewayOutcome =
  | { readonly status: "APPROVED"; readonly transactionId: string }
  | { readonly status: "DECLINED" }
  | { readonly status: "NOT_SUBMITTED" }
  | { readonly status: "UNKNOWN" };

export interface PaymentGateway {
  readonly name: string;
  process(
    payment: PaymentCommand,
    signal: AbortSignal,
  ): Promise<GatewayOutcome>;
}

type Attempt = Readonly<{
  gateway: string;
  outcome: GatewayOutcome["status"] | "CIRCUIT_OPEN";
}>;
export type PaymentResult = Readonly<
  {
    attempts: readonly Attempt[];
  } & (
    | { status: "APPROVED"; gateway: string; transactionId: string }
    | { status: "DECLINED" | "UNKNOWN"; gateway: string }
    | { status: "UNAVAILABLE"; gateway: null }
  )
>;

type Circuit =
  | { kind: "closed"; epoch: number; failures: number }
  | { kind: "open"; epoch: number; retryAt: number }
  | { kind: "probing"; epoch: number };

interface GatewaySlot {
  gateway: PaymentGateway;
  circuit: Circuit;
}

interface Options {
  timeoutMs: number;
  failureThreshold: number;
  cooldownMs: number;
  now?: () => number;
}

export class PaymentOrchestrator {
  readonly #gateways: readonly GatewaySlot[];
  readonly #options: Options;
  readonly #now: () => number;

  constructor(gateways: readonly PaymentGateway[], options: Options) {
    if (
      gateways.length === 0 ||
      new Set(gateways.map(({ name }) => name)).size !== gateways.length
    ) {
      throw new Error("Configure at least one gateway, with unique names.");
    }
    this.#gateways = gateways.map((gateway) => ({
      gateway,
      circuit: { kind: "closed", epoch: 0, failures: 0 },
    }));
    this.#options = { ...options };
    this.#now = options.now ?? (() => performance.now());
  }

  #admit(slot: GatewaySlot): number | undefined {
    const { circuit } = slot;
    if (circuit.kind === "closed") return circuit.epoch;
    if (circuit.kind === "probing" || this.#now() < circuit.retryAt)
      return undefined;
    slot.circuit = { kind: "probing", epoch: circuit.epoch };
    return circuit.epoch;
  }

  #record(slot: GatewaySlot, epoch: number, healthy: boolean): void {
    const { circuit } = slot;
    // A result from before the circuit opened must not change the new circuit.
    if (circuit.epoch !== epoch || circuit.kind === "open") return;
    if (healthy) {
      slot.circuit = {
        kind: "closed",
        epoch: epoch + Number(circuit.kind === "probing"),
        failures: 0,
      };
      return;
    }
    if (
      circuit.kind === "probing" ||
      circuit.failures + 1 >= this.#options.failureThreshold
    ) {
      slot.circuit = {
        kind: "open",
        epoch: epoch + 1,
        retryAt: this.#now() + this.#options.cooldownMs,
      };
    } else {
      slot.circuit = {
        ...circuit,
        failures: circuit.failures + 1,
      };
    }
  }

  async #attempt(
    gateway: PaymentGateway,
    payment: PaymentCommand,
  ): Promise<GatewayOutcome> {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const deadline = new Promise<GatewayOutcome>((resolve) => {
        timer = setTimeout(() => {
          resolve({ status: "UNKNOWN" });
          controller.abort();
        }, this.#options.timeoutMs);
      });
      return await Promise.race([
        deadline,
        gateway.process(payment, controller.signal),
      ]);
    } catch {
      return { status: "UNKNOWN" };
    } finally {
      clearTimeout(timer);
    }
  }

  async execute(payment: PaymentCommand): Promise<PaymentResult> {
    const attempts: Attempt[] = [];
    for (const slot of this.#gateways) {
      const { gateway } = slot;
      const epoch = this.#admit(slot);
      if (epoch === undefined) {
        attempts.push({ gateway: gateway.name, outcome: "CIRCUIT_OPEN" });
        continue;
      }
      const outcome = await this.#attempt(gateway, payment);
      this.#record(
        slot,
        epoch,
        outcome.status === "APPROVED" || outcome.status === "DECLINED",
      );
      attempts.push({ gateway: gateway.name, outcome: outcome.status });
      if (outcome.status !== "NOT_SUBMITTED") {
        return { ...outcome, gateway: gateway.name, attempts };
      }
    }
    return { status: "UNAVAILABLE", gateway: null, attempts };
  }
}

export function createSimulator(role: "primary" | "fallback"): PaymentGateway {
  return {
    name: `simulator-${role}`,
    process(payment) {
      if (role === "primary" && payment.method === "CREDIT_CARD") {
        switch (payment.paymentToken) {
          case "tok_sim_declined":
            return Promise.resolve({ status: "DECLINED" });
          case "tok_sim_fallback":
            return Promise.resolve({ status: "NOT_SUBMITTED" });
          case "tok_sim_unknown":
            return Promise.resolve({ status: "UNKNOWN" });
        }
      }
      return Promise.resolve({
        status: "APPROVED",
        transactionId: `sim_${randomUUID()}`,
      });
    },
  };
}
