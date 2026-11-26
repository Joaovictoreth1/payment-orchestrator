import { readFile } from 'node:fs/promises';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { join } from 'node:path';

import { HttpError, IdempotencyStore } from './idempotency.ts';
import type { OrchestratorResult, PaymentOrchestrator, PaymentRequest } from './payment_orchestrator.ts';

const MAX_BODY_BYTES = 16 * 1024;
const ASSETS = new Map<string, readonly [string, string]>([
  ['/', ['index.html', 'text/html; charset=utf-8']],
  ['/assets/dashboard.js', ['dashboard.js', 'text/javascript; charset=utf-8']],
  ['/assets/dashboard.css', ['dashboard.css', 'text/css; charset=utf-8']],
]);

interface PaymentResponse {
  status: number;
  body: { message: string; data: OrchestratorResult };
}

interface ServerOptions {
  dashboardDir?: string;
  idempotency?: IdempotencyStore<PaymentResponse>;
}

async function readPayment(req: IncomingMessage): Promise<PaymentRequest> {
  const contentType = req.headers['content-type']?.split(';', 1)[0].trim().toLowerCase();
  if (contentType !== 'application/json') {
    throw new HttpError(415, 'Use Content-Type: application/json.');
  }
  if (Number(req.headers['content-length']) > MAX_BODY_BYTES) {
    throw new HttpError(413, 'Payload acima do limite permitido (16 KiB).');
  }

  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req.iterator({ destroyOnReturn: false })) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > MAX_BODY_BYTES) throw new HttpError(413, 'Payload acima do limite permitido (16 KiB).');
    chunks.push(buffer);
  }

  let content: unknown;
  try {
    content = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new HttpError(400, 'JSON inválido.');
  }
  if (!content || typeof content !== 'object' || Array.isArray(content)) {
    throw new HttpError(400, 'JSON inválido: esperado um objeto.');
  }
  if (Object.keys(content).some((key) => key !== 'amount' && key !== 'currency' && key !== 'method')) {
    throw new HttpError(400, 'Use apenas amount, currency e method. Não envie dados de cartão.');
  }

  const { amount, currency = 'BRL', method } = content as Record<string, unknown>;
  if (typeof amount !== 'number' || !Number.isFinite(amount) || amount <= 0 ||
      amount > 1_000_000 || amount !== Math.round(amount * 100) / 100) {
    throw new HttpError(400, 'Informe um valor entre 0,01 e 1.000.000 com até duas casas decimais.');
  }
  if (currency !== 'BRL' && currency !== 'USD' && currency !== 'EUR') {
    throw new HttpError(400, 'Moeda inválida. Valores aceitos: BRL, USD, EUR.');
  }
  if (method !== 'CREDIT_CARD' && method !== 'PIX') {
    throw new HttpError(400, 'Método inválido. Valores aceitos: CREDIT_CARD, PIX.');
  }
  return { amount, currency, method };
}

function send(
  res: ServerResponse, status: number, body: string | Buffer, contentType: string, close = false,
) {
  if (res.destroyed) return;
  res.writeHead(status, {
    'Content-Type': contentType,
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    'Content-Security-Policy': "default-src 'self'; object-src 'none'; frame-ancestors 'none'; base-uri 'none'",
    ...(close ? { Connection: 'close' } : {}),
  });
  res.end(body);
}

function sendJson(res: ServerResponse, status: number, data: unknown, close = false) {
  send(res, status, JSON.stringify(data), 'application/json; charset=utf-8', close);
}

export function createPaymentServer(
  orchestrator: Pick<PaymentOrchestrator, 'executePayment'>,
  { dashboardDir, idempotency = new IdempotencyStore<PaymentResponse>() }: ServerOptions = {},
) {
  return createServer({
    requestTimeout: 10_000,
    headersTimeout: 5_000,
    connectionsCheckingInterval: 1_000,
  }, async (req, res) => {
    const path = req.url?.split('?', 1)[0] ?? '/';
    try {
      if (req.method === 'GET' && path === '/health') {
        sendJson(res, 200, { status: 'ok', uptimeSeconds: Math.floor(process.uptime()) });
        return;
      }
      const asset = req.method === 'GET' && dashboardDir ? ASSETS.get(path) : undefined;
      if (asset && dashboardDir) {
        const [file, type] = asset;
        send(res, 200, await readFile(join(dashboardDir, file)), type);
        return;
      }
      if (req.method !== 'POST' || path !== '/api/v1/payments/process') {
        sendJson(res, 404, { error: 'Not found.' }, !req.complete);
        return;
      }

      const key = req.headers['idempotency-key'];
      if (key !== undefined && (typeof key !== 'string' || !/^[A-Za-z0-9._:-]{1,128}$/.test(key))) {
        throw new HttpError(400, 'Idempotency-Key must use 1–128 letters, digits, or ._:-');
      }
      const payment = await readPayment(req);
      const execute = async (): Promise<PaymentResponse> => {
        const result = await orchestrator.executePayment(payment);
        return {
          status: result.success ? 200 : result.errorCode === 'GATEWAY_UNAVAILABLE' ? 503 : 402,
          body: { message: result.success ? 'Pagamento Aprovado!' : 'Pagamento Recusado.', data: result },
        };
      };
      const response = await (key === undefined ? execute() : idempotency.run(
        key, JSON.stringify([payment.amount, payment.currency, payment.method]), execute,
      ));
      sendJson(res, response.status, response.body);
    } catch (error) {
      if (error instanceof HttpError) {
        sendJson(res, error.statusCode, { error: error.message }, !req.complete || error.statusCode === 413);
      } else {
        console.error(JSON.stringify({ event: 'request_failed' }));
        sendJson(res, 500, { error: 'Erro interno no servidor.' }, !req.complete);
      }
    }
  });
}
