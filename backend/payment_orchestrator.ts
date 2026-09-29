import { randomUUID } from 'node:crypto';
import { createServer, IncomingMessage, ServerResponse } from 'node:http';
import { performance } from 'node:perf_hooks';
import { setTimeout as delay } from 'node:timers/promises';
import { URL } from 'node:url';

// ==========================================
// 1. DOMÍNIO E INTERFACES (Contratos)
// ==========================================
export type PaymentMethod = 'CREDIT_CARD' | 'PIX';
export type CurrencyCode = 'BRL' | 'USD' | 'EUR';
export type ErrorCode =
  | 'CARD_DECLINED'
  | 'ANTIFRAUD_REJECTED'
  | 'GATEWAY_TIMEOUT'
  | 'GATEWAY_UNAVAILABLE';

export interface PaymentRequest {
  readonly amount: number;
  readonly currency: CurrencyCode;
  readonly method: PaymentMethod;
  readonly cardNumber?: string;
  readonly idempotencyKey?: string;
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
  process(request: PaymentRequest, signal?: AbortSignal): Promise<PaymentResult>;
}

export class HttpError extends Error {
  constructor(
    public readonly statusCode: number,
    message: string,
  ) {
    super(message);
    this.name = 'HttpError';
  }
}

// ==========================================
// 2. GATEWAYS (Mocks)
// ==========================================
export class StripeGatewayMock implements IPaymentGateway {
  public readonly name = 'Stripe (Gateway Primário)';

  public async process(_request: PaymentRequest, signal?: AbortSignal): Promise<PaymentResult> {
    const startTime = performance.now();

    await delay(800, undefined, { signal });

    if (Math.random() > 0.8) {
      throw new Error('Stripe Timeout: A API não respondeu a tempo.');
    }

    const isSuccess = Math.random() > 0.3;
    const processingTimeMs = Math.round(performance.now() - startTime);

    return {
      success: isSuccess,
      transactionId: isSuccess ? `strp_${randomUUID()}` : undefined,
      gatewayUsed: this.name,
      errorCode: isSuccess ? undefined : 'CARD_DECLINED',
      errorMessage: isSuccess ? undefined : 'Cartão recusado pelo banco emissor.',
      processingTimeMs,
    };
  }
}

export class PagarMeGatewayMock implements IPaymentGateway {
  public readonly name = 'Pagar.me (Fallback)';

  public async process(_request: PaymentRequest, signal?: AbortSignal): Promise<PaymentResult> {
    const startTime = performance.now();

    await delay(600, undefined, { signal });

    const isSuccess = Math.random() > 0.1;
    const processingTimeMs = Math.round(performance.now() - startTime);

    return {
      success: isSuccess,
      transactionId: isSuccess ? `pgm_${randomUUID()}` : undefined,
      gatewayUsed: this.name,
      errorCode: isSuccess ? undefined : 'ANTIFRAUD_REJECTED',
      errorMessage: isSuccess ? undefined : 'Falha no anti-fraude.',
      processingTimeMs,
    };
  }
}

// ==========================================
// 3. CIRCUIT BREAKER & ORQUESTRADOR
// ==========================================
interface CircuitState {
  failures: number;
  openedAt: number | null;
}

export interface AttemptLog {
  readonly gateway: string;
  readonly outcome: 'SUCCESS' | 'DECLINED' | 'TECHNICAL_ERROR' | 'CIRCUIT_OPEN';
  readonly reason?: string;
}

export interface OrchestratorResult extends PaymentResult {
  readonly retries: number;
  readonly maskedCard?: string;
  readonly attempts: readonly AttemptLog[];
}

export class PaymentOrchestrator {
  private readonly gateways: readonly IPaymentGateway[];
  private readonly circuits = new Map<string, CircuitState>();
  private readonly failureThreshold = 3;
  private readonly cooldownMs = 15_000;
  private readonly timeoutMs = 2_000;

  constructor(gateways: readonly IPaymentGateway[]) {
    if (gateways.length === 0) {
      throw new Error('Pelo menos um gateway deve ser registrado no orquestrador.');
    }
    this.gateways = gateways;
    for (const gw of gateways) {
      this.circuits.set(gw.name, { failures: 0, openedAt: null });
    }
  }

  private isCircuitOpen(gatewayName: string): boolean {
    const state = this.circuits.get(gatewayName);
    if (!state || state.openedAt === null) return false;

    if (Date.now() - state.openedAt >= this.cooldownMs) {
      // Half-Open: permite uma nova tentativa após o tempo de cooldown
      state.openedAt = null;
      state.failures = 0;
      return false;
    }
    return true;
  }

  private recordTechnicalFailure(gatewayName: string): void {
    const state = this.circuits.get(gatewayName);
    if (!state) return;

    state.failures += 1;
    if (state.failures >= this.failureThreshold) {
      state.openedAt = Date.now();
      console.warn(`[CircuitBreaker] Circuito ABERTO para ${gatewayName} por ${this.cooldownMs / 1000}s.`);
    }
  }

  private resetCircuit(gatewayName: string): void {
    const state = this.circuits.get(gatewayName);
    if (state) {
      state.failures = 0;
      state.openedAt = null;
    }
  }

  public async executePayment(request: PaymentRequest): Promise<OrchestratorResult> {
    const startTime = performance.now();
    const maskedCard = request.cardNumber ? maskCardNumber(request.cardNumber) : undefined;
    const attempts: AttemptLog[] = [];
    let lastBusinessDecline: PaymentResult | undefined;
    let actualCalls = 0;

    console.log(
      `[Orquestrador] Iniciando pagamento: ${request.amount} ${request.currency} | Método: ${request.method}${maskedCard ? ` | Cartão: ${maskedCard}` : ''}`,
    );

    for (const gateway of this.gateways) {
      if (this.isCircuitOpen(gateway.name)) {
        attempts.push({
          gateway: gateway.name,
          outcome: 'CIRCUIT_OPEN',
          reason: 'Gateway temporariamente isolado por falhas consecutivas.',
        });
        continue;
      }

      actualCalls += 1;

      try {
        const signal = AbortSignal.timeout(this.timeoutMs);
        const result = await gateway.process(request, signal);

        // O gateway respondeu dentro do tempo: reseta o contador de falhas técnicas
        this.resetCircuit(gateway.name);

        if (result.success) {
          attempts.push({ gateway: gateway.name, outcome: 'SUCCESS' });
          return {
            ...result,
            processingTimeMs: Math.round(performance.now() - startTime),
            retries: actualCalls - 1,
            maskedCard,
            attempts,
          };
        }

        lastBusinessDecline = result;
        attempts.push({
          gateway: gateway.name,
          outcome: 'DECLINED',
          reason: result.errorMessage,
        });
        console.warn(`[Orquestrador] Recusado em ${gateway.name}: ${result.errorMessage}`);
      } catch (error: unknown) {
        this.recordTechnicalFailure(gateway.name);
        const message = error instanceof Error ? error.message : 'Erro desconhecido';
        attempts.push({
          gateway: gateway.name,
          outcome: 'TECHNICAL_ERROR',
          reason: message,
        });
        console.error(`[Orquestrador] Erro crítico em ${gateway.name}: ${message}`);
      }
    }

    const totalTimeMs = Math.round(performance.now() - startTime);
    const retries = Math.max(0, actualCalls - 1);

    if (lastBusinessDecline) {
      return {
        ...lastBusinessDecline,
        processingTimeMs: totalTimeMs,
        retries,
        maskedCard,
        attempts,
      };
    }

    return {
      success: false,
      gatewayUsed: 'None',
      errorCode: 'GATEWAY_UNAVAILABLE',
      errorMessage: 'Indisponibilidade geral: Todos os gateways falharam.',
      processingTimeMs: totalTimeMs,
      retries,
      maskedCard,
      attempts,
    };
  }
}

// ==========================================
// 4. UTILITÁRIOS DE SEGURANÇA E HTTP
// ==========================================
const MAX_BODY_BYTES = 16 * 1024;
const idempotencyStore = new Map<string, { status: number; body: unknown }>();

function maskCardNumber(cardNumber: string): string {
  const digits = cardNumber.replace(/\D/g, '');
  return `**** **** **** ${digits.slice(-4)}`;
}

async function parseJsonBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let receivedBytes = 0;

  for await (const chunk of req) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    receivedBytes += buf.byteLength;
    if (receivedBytes > MAX_BODY_BYTES) {
      throw new HttpError(413, 'Payload acima do limite permitido (16KB).');
    }
    chunks.push(buf);
  }

  const rawBody = Buffer.concat(chunks).toString('utf8').trim();
  if (!rawBody) return {};

  try {
    const parsed: unknown = JSON.parse(rawBody);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new HttpError(400, 'JSON inválido: esperado um objeto.');
    }
    return parsed as Record<string, unknown>;
  } catch (err) {
    if (err instanceof HttpError) throw err;
    throw new HttpError(400, 'JSON inválido.');
  }
}

function validatePaymentInput(body: Record<string, unknown>, idempotencyKey?: string): PaymentRequest {
  const { amount, currency = 'BRL', method, cardNumber } = body;

  if (typeof amount !== 'number' || !Number.isFinite(amount) || amount <= 0) {
    throw new HttpError(400, 'O campo "amount" é obrigatório e deve ser um número maior que zero.');
  }

  if (method !== 'CREDIT_CARD' && method !== 'PIX') {
    throw new HttpError(400, 'Método inválido. Valores aceitos: CREDIT_CARD, PIX.');
  }

  if (currency !== 'BRL' && currency !== 'USD' && currency !== 'EUR') {
    throw new HttpError(400, 'Moeda inválida. Valores aceitos: BRL, USD, EUR.');
  }

  let sanitizedCard: string | undefined;
  if (method === 'CREDIT_CARD') {
    if (typeof cardNumber !== 'string' || !/^\d{13,19}$/.test(cardNumber.replace(/\s+/g, ''))) {
      throw new HttpError(400, 'Para CREDIT_CARD, informe um "cardNumber" válido (13 a 19 dígitos).');
    }
    sanitizedCard = cardNumber.replace(/\s+/g, '');
  }

  return {
    amount: Math.round(amount * 100) / 100,
    currency,
    method,
    cardNumber: sanitizedCard,
    idempotencyKey,
  };
}

function sendJson(res: ServerResponse, statusCode: number, data: unknown): void {
  const payload = JSON.stringify(data);
  res.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(payload),
  });
  res.end(payload);
}

// ==========================================
// 5. ROTAS E SERVIDOR
// ==========================================
const orchestrator = new PaymentOrchestrator([
  new StripeGatewayMock(),
  new PagarMeGatewayMock(),
]);

const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
  const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);

  if (req.method === 'GET' && url.pathname === '/health') {
    sendJson(res, 200, { status: 'ok', uptimeSeconds: Math.floor(process.uptime()) });
    return;
  }

  if (req.method !== 'POST' || url.pathname !== '/api/v1/payments/process') {
    sendJson(res, 404, { error: 'Not found.' });
    return;
  }

  try {
    const rawIdempotency = req.headers['idempotency-key'];
    const idempotencyKey = typeof rawIdempotency === 'string' ? rawIdempotency.trim() : undefined;

    if (idempotencyKey && idempotencyStore.has(idempotencyKey)) {
      const cached = idempotencyStore.get(idempotencyKey)!;
      sendJson(res, cached.status, cached.body);
      return;
    }

    const body = await parseJsonBody(req);
    const paymentRequest = validatePaymentInput(body, idempotencyKey);
    const result = await orchestrator.executePayment(paymentRequest);

    const status = result.success
      ? 200
      : result.errorCode === 'GATEWAY_UNAVAILABLE'
        ? 503
        : 402;

    const responseBody = {
      message: result.success ? 'Pagamento Aprovado!' : 'Pagamento Recusado.',
      data: result,
    };

    if (idempotencyKey) {
      idempotencyStore.set(idempotencyKey, { status, body: responseBody });
    }

    sendJson(res, status, responseBody);
  } catch (error: unknown) {
    if (error instanceof HttpError) {
      sendJson(res, error.statusCode, { error: error.message });
      return;
    }

    console.error('[API] Erro fatal não tratado:', error);
    sendJson(res, 500, { error: 'Erro interno no servidor.' });
  }
});

const PORT = Number(process.env.PORT) || 3000;
server.listen(PORT, () => {
  console.log(`🚀 Payment Orchestrator rodando em http://localhost:${PORT}/api/v1/payments/process`);
});

// Graceful Shutdown para encerrar conexões pendentes com segurança
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    console.log(`\n[${signal}] Encerrando servidor de pagamentos...`);
    server.close(() => process.exit(0));
  });
}
