import { isIP } from 'node:net';
import { join } from 'node:path';

import { createPaymentServer } from './http.ts';
import { PagarMeGatewayMock, PaymentOrchestrator, StripeGatewayMock } from './payment_orchestrator.ts';

const host = process.env.HOST ?? '127.0.0.1';
const port = process.env.PORT ?? '3000';
if (!isIP(host) && host !== 'localhost') throw new Error('HOST must be an IP address or localhost.');
if (!/^\d{1,5}$/.test(port) || Number(port) < 1 || Number(port) > 65_535) {
  throw new Error('PORT must be an integer between 1 and 65535.');
}

const orchestrator = new PaymentOrchestrator([new StripeGatewayMock(), new PagarMeGatewayMock()]);
const server = createPaymentServer(orchestrator, { dashboardDir: join(import.meta.dirname, 'public') });
server.listen(Number(port), host, () => {
  console.info(JSON.stringify({ event: 'listening', host, port: Number(port), mode: 'mock' }));
});

function stop(signal: NodeJS.Signals) {
  console.info(JSON.stringify({ event: 'shutdown', signal }));
  server.close((error) => {
    if (error) process.exitCode = 1;
  });
}

process.once('SIGINT', stop);
process.once('SIGTERM', stop);
