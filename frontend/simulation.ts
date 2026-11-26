import type { AttemptLog, OrchestratorResult, PaymentRequest } from '../backend/payment_orchestrator.ts';

const outcomes = new Set(['SUCCESS', 'DECLINED', 'TECHNICAL_ERROR', 'CIRCUIT_OPEN']);
const historyLimit = 25;

type SimulationResult = { message: string; data: OrchestratorResult };
type SimulationFailure = { error: string; retryable: boolean };
type Simulation = SimulationResult | SimulationFailure;
type SimulationStatus = 'approved' | 'declined' | 'unavailable';
type HistoryEntry = { id: string; time: number; payment: PaymentRequest; result: SimulationResult };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isAttempt(value: unknown): value is AttemptLog {
  return isRecord(value) && typeof value.gateway === 'string' &&
    typeof value.outcome === 'string' && outcomes.has(value.outcome) &&
    (value.reason === undefined || typeof value.reason === 'string');
}

function isResult(value: unknown): value is SimulationResult {
  if (!isRecord(value) || typeof value.message !== 'string' || !isRecord(value.data)) return false;
  const { success, gatewayUsed, processingTimeMs, retries, attempts, errorCode, transactionId } = value.data;
  return typeof success === 'boolean' && typeof gatewayUsed === 'string' &&
    typeof processingTimeMs === 'number' && Number.isFinite(processingTimeMs) && processingTimeMs >= 0 &&
    typeof retries === 'number' && Number.isSafeInteger(retries) && retries >= 0 &&
    (errorCode === undefined || errorCode === 'CARD_DECLINED' ||
      errorCode === 'ANTIFRAUD_REJECTED' || errorCode === 'GATEWAY_UNAVAILABLE') &&
    (transactionId === undefined || typeof transactionId === 'string') &&
    Array.isArray(attempts) && attempts.every(isAttempt);
}

export function parseAmount(raw: string): number | null {
  if (!/^\d+(?:[.,]\d{1,2})?$/.test(raw.trim())) return null;
  const amount = Number(raw.trim().replace(',', '.'));
  return amount >= 0.01 && amount <= 1_000_000 ? amount : null;
}

export function simulationStatus(result: SimulationResult): SimulationStatus {
  if (result.data.success) return 'approved';
  return result.data.errorCode === 'GATEWAY_UNAVAILABLE' ? 'unavailable' : 'declined';
}

export async function requestSimulation(
  payment: PaymentRequest, key: string, request = fetch,
): Promise<Simulation> {
  try {
    const response = await request('/api/v1/payments/process', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Idempotency-Key': key },
      body: JSON.stringify(payment),
      signal: AbortSignal.timeout(12_000),
    });
    const value: unknown = await response.json();
    if (isResult(value)) {
      const status = simulationStatus(value);
      const expected = status === 'approved' ? 200 : status === 'unavailable' ? 503 : 402;
      if (response.status === expected) return value;
    }
    if (response.status >= 400 && response.status < 500 && isRecord(value) && typeof value.error === 'string') {
      return { error: value.error, retryable: false };
    }
  } catch {
    // The server may have completed the request even though no response arrived.
  }
  return {
    error: 'Não foi possível confirmar o resultado. Tente novamente para consultar a mesma simulação.',
    retryable: true,
  };
}

export function addHistory(history: HistoryEntry[], entry: HistoryEntry): HistoryEntry[] {
  return [entry, ...history.filter((item) => item.id !== entry.id)].slice(0, historyLimit);
}

export function filterHistory(
  history: HistoryEntry[], status: SimulationStatus | 'all', method: PaymentRequest['method'] | 'all',
): HistoryEntry[] {
  return history.filter(({ payment, result }) =>
    (status === 'all' || simulationStatus(result) === status) &&
    (method === 'all' || payment.method === method));
}
