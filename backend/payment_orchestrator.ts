import { createServer, IncomingMessage, ServerResponse } from 'http';
import { URL } from 'url';

// ==========================================
// 1. DOMÍNIO E INTERFACES (Contratos)
// ==========================================
export interface PaymentRequest {
  amount: number;
  currency: string;
  method: 'CREDIT_CARD' | 'PIX';
  cardNumber?: string;
}

export interface PaymentResult {
  success: boolean;
  transactionId?: string;
  gatewayUsed: string;
  errorMessage?: string;
  processingTimeMs: number;
}

export interface IPaymentGateway {
  name: string;
  process(request: PaymentRequest): Promise<PaymentResult>;
}

// ==========================================
// 2. GATEWAYS (Mocks)
// ==========================================
export class StripeGatewayMock implements IPaymentGateway {
  public name = 'Stripe (Gateway Primário)';

  public async process(request: PaymentRequest): Promise<PaymentResult> {
    const startTime = Date.now();
    
    // Simula delay da rede
    await new Promise((resolve) => setTimeout(resolve, 800));

    // Simula erro de rede/timeout do gateway em 20% das vezes
    if (Math.random() > 0.8) {
      throw new Error('Stripe Timeout: A API não respondeu a tempo.');
    }

    const isSuccess = Math.random() > 0.3; // 70% de chance do cartão passar
    const processingTimeMs = Date.now() - startTime;

    return {
      success: isSuccess,
      transactionId: isSuccess ? `strp_${Date.now()}` : undefined,
      gatewayUsed: this.name,
      errorMessage: isSuccess ? undefined : 'Cartão recusado pelo banco emissor.',
      processingTimeMs,
    };
  }
}

export class PagarMeGatewayMock implements IPaymentGateway {
  public name = 'Pagar.me (Fallback)';

  public async process(request: PaymentRequest): Promise<PaymentResult> {
    const startTime = Date.now();
    
    // Simula delay da rede
    await new Promise((resolve) => setTimeout(resolve, 600));

    const isSuccess = Math.random() > 0.1; // 90% de sucesso no fallback
    const processingTimeMs = Date.now() - startTime;

    return {
      success: isSuccess,
      transactionId: isSuccess ? `pgm_${Date.now()}` : undefined,
      gatewayUsed: this.name,
      errorMessage: isSuccess ? undefined : 'Falha no anti-fraude.',
      processingTimeMs,
    };
  }
}

// ==========================================
// 3. ORQUESTRADOR
// ==========================================
export interface OrchestratorResult extends PaymentResult {
  retries: number;
}

export class PaymentOrchestrator {
  constructor(
    private primaryGateway: IPaymentGateway,
    private secondaryGateway: IPaymentGateway
  ) {}

  public async executePayment(request: PaymentRequest): Promise<OrchestratorResult> {
    console.log(`[Orquestrador] Processando pagamento de ${request.amount} ${request.currency} via ${request.method}...`);
    
    const startTime = Date.now();

    // --- TENTATIVA 1: Gateway Primário ---
    try {
      const primaryResult = await this.primaryGateway.process(request);
      
      if (primaryResult.success) {
        return { ...primaryResult, retries: 0 };
      }
      
      console.warn(`[Orquestrador] Recusado no primário. Motivo: ${primaryResult.errorMessage}. Acionando Fallback...`);
    } catch (error: any) {
      console.error(`[Orquestrador] Erro crítico no primário: ${error.message}. Acionando Fallback...`);
    }

    // --- TENTATIVA 2: Fallback (Secundário) ---
    try {
      const fallbackResult = await this.secondaryGateway.process(request);
      return { ...fallbackResult, retries: 1 };
    } catch (fallbackError: any) {
      console.error(`[Orquestrador] Erro crítico no fallback: ${fallbackError.message}.`);
      
      return {
        success: false,
        gatewayUsed: 'None',
        errorMessage: 'Indisponibilidade geral: Ambos os gateways falharam.',
        processingTimeMs: Date.now() - startTime,
        retries: 1,
      };
    }
  }
}

// ==========================================
// 4. ROTAS E SERVIDOR
// ==========================================
const orchestrator = new PaymentOrchestrator(
  new StripeGatewayMock(),
  new PagarMeGatewayMock()
);

function getRequestBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let body = '';

    req.on('data', (chunk) => {
      body += chunk;
    });

    req.on('end', () => resolve(body));
    req.on('error', reject);
  });
}

const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
  const url = new URL(req.url ?? '', `http://${req.headers.host ?? 'localhost'}`);

  if (req.method !== 'POST' || url.pathname !== '/api/v1/payments/process') {
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Not found.' }));
    return;
  }

  try {
    const rawBody = await getRequestBody(req);
    let body: any;

    try {
      body = rawBody ? JSON.parse(rawBody) : {};
    } catch {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'JSON inválido.' }));
      return;
    }

    if (!body || typeof body.amount !== 'number' || body.amount <= 0) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'O campo "amount" é obrigatório e deve ser um número maior que zero.' }));
      return;
    }

    if (body.method !== 'CREDIT_CARD' && body.method !== 'PIX') {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Método inválido. Valores aceitos: CREDIT_CARD, PIX.' }));
      return;
    }

    const paymentRequest: PaymentRequest = {
      amount: body.amount,
      currency: body.currency || 'BRL',
      method: body.method,
      cardNumber: body.cardNumber,
    };

    const result = await orchestrator.executePayment(paymentRequest);
    const status = result.success ? 200 : 402;

    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ message: result.success ? 'Pagamento Aprovado!' : 'Pagamento Recusado.', data: result }));

  } catch (error) {
    console.error('[API] Erro fatal não tratado:', error);
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Erro interno no servidor.' }));
  }
});

// Inicialização
const PORT = 3000;
server.listen(PORT, () => {
  console.log(`🚀 Payment Orchestrator rodando perfeitamente!`);
  console.log(`➡️  Faça um POST em http://localhost:${PORT}/api/v1/payments/process`);
});