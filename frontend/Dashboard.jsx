import { createElement, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';

import './dashboard.css';

function Dashboard() {
  const [amount, setAmount] = useState('25.00');
  const [currency, setCurrency] = useState('BRL');
  const [method, setMethod] = useState('PIX');
  const [pending, setPending] = useState(false);
  const [reply, setReply] = useState(null);
  const attempt = useRef(null);
  const busy = useRef(false);

  async function simulate(event) {
    event.preventDefault();
    if (busy.current) return;
    busy.current = true;
    setPending(true);
    setReply(null);
    const body = JSON.stringify({ amount: Number(amount), currency, method });
    if (attempt.current?.body !== body) attempt.current = { body, key: crypto.randomUUID() };

    try {
      const response = await fetch('/api/v1/payments/process', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Idempotency-Key': attempt.current.key },
        body,
      });
      const result = await response.json();
      attempt.current = null;
      setReply(result);
    } catch {
      setReply({ error: 'Não foi possível obter a resposta. Tente novamente para consultar a mesma simulação.' });
    } finally {
      busy.current = false;
      setPending(false);
    }
  }

  return (
    <main className="shell">
      <header className="top">
        <span className="brand">Orquestrador <span>/</span> Pagamentos</span>
        <span className="badge">AMBIENTE SIMULADO</span>
      </header>
      <section className="intro">
        <p className="eyebrow">LABORATÓRIO DE PAGAMENTOS</p>
        <h1>Simule um pagamento</h1>
        <p>Experimente o fluxo entre o gateway primário e o de contingência. Nenhum valor é cobrado.</p>
      </section>
      <div className="workspace">
        <section className="panel" aria-labelledby="request-heading">
          <h2 id="request-heading">Dados da simulação</h2>
          <p className="muted">Não insira informações reais de pagamento.</p>
          <form onSubmit={simulate}>
            <fieldset disabled={pending}>
              <div className="inputs">
                <label>Valor
                  <input type="number" min="0.01" max="1000000" step="0.01" required
                    value={amount} onChange={(event) => setAmount(event.target.value)} />
                </label>
                <label>Moeda
                  <select value={currency} onChange={(event) => setCurrency(event.target.value)}>
                    <option value="BRL">BRL</option><option value="USD">USD</option><option value="EUR">EUR</option>
                  </select>
                </label>
              </div>
              <label>Método
                <select value={method} onChange={(event) => setMethod(event.target.value)}>
                  <option value="PIX">Pix</option><option value="CREDIT_CARD">Cartão simulado</option>
                </select>
              </label>
              <button type="submit">{pending ? 'Simulando…' : 'Simular pagamento'}</button>
            </fieldset>
          </form>
        </section>
        <section className="panel result" aria-labelledby="result-heading">
          <h2 id="result-heading">Resultado</h2>
          <div aria-live="polite" aria-atomic="true">
            {pending ? <p className="empty">Aguardando resposta dos gateways…</p> : !reply ?
              <p className="empty">O resultado e as tentativas aparecerão aqui após a simulação.</p> :
              reply.error ? <p className="notice error">{reply.error}</p> : (
                <>
                  <p className={`notice ${reply.data.success ? 'success' : 'error'}`}>
                    {reply.data.errorCode === 'GATEWAY_UNAVAILABLE' ? 'Gateways indisponíveis' : reply.message}
                  </p>
                  <dl>
                    <div><dt>Gateway</dt><dd>{reply.data.gatewayUsed}</dd></div>
                    <div><dt>Tempo total</dt><dd>{reply.data.processingTimeMs} ms</dd></div>
                    <div><dt>Tentativas adicionais</dt><dd>{reply.data.retries}</dd></div>
                  </dl>
                  <ol className="attempts" aria-label="Tentativas">
                    {reply.data.attempts.map((item) => (
                      <li key={item.gateway}><span>{item.gateway}</span><code>{item.outcome}</code></li>
                    ))}
                  </ol>
                </>
              )}
          </div>
        </section>
      </div>
      <footer>DEMONSTRAÇÃO LOCAL <span>·</span> SEM INTEGRAÇÃO COM PROVEDORES REAIS</footer>
    </main>
  );
}

createRoot(document.getElementById('root')).render(createElement(Dashboard));