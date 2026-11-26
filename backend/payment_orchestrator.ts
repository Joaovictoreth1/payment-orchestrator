import { randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { setTimeout as delay } from 'node:timers/promises';

export type PaymentMethod = 'CREDIT_CARD' | 'PIX';
export type CurrencyCode = 'BRL' | 'USD' | 'EUR';
export type ErrorCode = 'CARD_DECLINED' | 'ANTIFRAUD_REJECTED' | 'GATEWAY_UNAVAILABLE';

export interface PaymentRequest {
  readonly amount: number;
  readonly currency: CurrencyCode;
  readonly method: PaymentMethod;
}

export interface PaymentResult {
  readonly success: boolean;
  readonly transactionId?: string;
  readonly gatewayUsed: string;
  readonly errorCode?: ErrorCode;
  readonly errorMessage?: string;
  readonly processingTimeMs: number;
}

export interface IPaymentGateway {
  readonly name: string;
  process(request: PaymentRequest, signal: AbortSignal): Promise<PaymentResult>;
}

export class StripeGatewayMock implements IPaymentGateway {
  readonly name = 'Stripe (Gateway Primário)';

  async process(_request: PaymentRequest, signal: AbortSignal): Promise<PaymentResult> {
    const start = performance.now();
    await delay(800, undefined, { signal });
    if (Math.random() > 0.8) throw new Error('Simulated gateway timeout');
    const success = Math.random() > 0.3;
    return {
      success,
      transactionId: success ? `strp_${randomUUID()}` : undefined,
      gatewayUsed: this.name,
      errorCode: success ? undefined : 'CARD_DECLINED',
      errorMessage: success ? undefined : 'Cartão recusado pelo banco emissor.',
      processingTimeMs: Math.round(performance.now() - start),
    };
  }
}

export class PagarMeGatewayMock implements IPaymentGateway {
  readonly name = 'Pagar.me (Fallback)';

  async process(_request: PaymentRequest, signal: AbortSignal): Promise<PaymentResult> {
    const start = performance.now();
    await delay(600, undefined, { signal });
    const success = Math.random() > 0.1;
    return {
      success,
      transactionId: success ? `pgm_${randomUUID()}` : undefined,
      gatewayUsed: this.name,
      errorCode: success ? undefined : 'ANTIFRAUD_REJECTED',
      errorMessage: success ? undefined : 'Falha no anti-fraude.',
      processingTimeMs: Math.round(performance.now() - start),
    };
  }
}

interface CircuitState {
  failures: number;
  retryAfter: number | null;
  probing: boolean;
  generation: number;
}

export interface AttemptLog {
  readonly gateway: string;
  readonly outcome: 'SUCCESS' | 'DECLINED' | 'TECHNICAL_ERROR' | 'CIRCUIT_OPEN';
  readonly reason?: string;
}

export interface OrchestratorResult extends PaymentResult {
  readonly retries: number;
  readonly attempts: readonly AttemptLog[];
}

interface CircuitOptions {
  now?: () => number;
  cooldownMs?: number;
  timeoutMs?: number;
}

export class PaymentOrchestrator {
  private readonly circuits: ReadonlyArray<{ gateway: IPaymentGateway; state: CircuitState }>;
  private readonly now: () => number;
  private readonly cooldownMs: number;
  private readonly timeoutMs: number;

  constructor(gateways: readonly IPaymentGateway[], options: CircuitOptions = {}) {
    if (gateways.length === 0) throw new Error('At least one gateway is required');
    this.now = options.now ?? (() => performance.now());
    this.cooldownMs = options.cooldownMs ?? 15_000;
    this.timeoutMs = options.timeoutMs ?? 2_000;
    this.circuits = gateways.map((gateway) => ({
      gateway,
      state: { failures: 0, retryAfter: null, probing: false, generation: 0 },
    }));
  }

  private async callGateway(gateway: IPaymentGateway, request: PaymentRequest) {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const timedOut = new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          reject(new Error('Gateway deadline exceeded'));
          controller.abort();
        }, this.timeoutMs);
      });
      return await Promise.race([gateway.process(request, controller.signal), timedOut]);
    } finally {
      clearTimeout(timer);
    }
  }

  async executePayment(request: PaymentRequest): Promise<OrchestratorResult> {
    const start = this.now();
    const attempts: AttemptLog[] = [];
    let lastDecline: PaymentResult | undefined;
    let calls = 0;
    const finish = (result: PaymentResult): OrchestratorResult => ({
      ...result,
      processingTimeMs: Math.round(this.now() - start),
      retries: Math.max(0, calls - 1),
      attempts,
    });

    for (const { gateway, state } of this.circuits) {
      if (state.retryAfter !== null) {
        if (state.probing || this.now() < state.retryAfter) {
          attempts.push({ gateway: gateway.name, outcome: 'CIRCUIT_OPEN' });
          continue;
        }
        state.probing = true;
      }

      const generation = state.generation;
      calls += 1;
      try {
        const result = await this.callGateway(gateway, request);
        if (generation === state.generation) {
          state.failures = 0;
          state.retryAfter = null;
          state.probing = false;
        }
        if (result.success) {
          attempts.push({ gateway: gateway.name, outcome: 'SUCCESS' });
          return finish(result);
        }
        lastDecline = result;
        attempts.push({ gateway: gateway.name, outcome: 'DECLINED', reason: result.errorMessage });
      } catch {
        if (generation === state.generation && (state.probing || ++state.failures >= 3)) {
          state.retryAfter = this.now() + this.cooldownMs;
          state.probing = false;
          state.generation += 1;
        }
        attempts.push({ gateway: gateway.name, outcome: 'TECHNICAL_ERROR', reason: 'Simulated gateway failed or timed out.' });
      }
    }

    return finish(lastDecline ?? {
      success: false,
      gatewayUsed: 'None',
      errorCode: 'GATEWAY_UNAVAILABLE',
      errorMessage: 'Indisponibilidade geral: Todos os gateways falharam.',
      processingTimeMs: 0,
    });
  }
}
