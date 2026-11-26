import { createElement, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';

import './dashboard.css';
import { addHistory, filterHistory, parseAmount, requestSimulation, simulationStatus } from './simulation.ts';

const statusLabels = {
  approved: 'Aprovado',
  declined: 'Recusado',
  unavailable: 'Gateways indisponíveis',
};
const methodLabels = { PIX: 'Pix', CREDIT_CARD: 'Cartão simulado' };
const attemptLabels = {
  SUCCESS: 'Aprovada',
  DECLINED: 'Recusada',
  TECHNICAL_ERROR: 'Erro técnico',
  CIRCUIT_OPEN: 'Gateway temporariamente suspenso',
};
const timeFormat = new Intl.DateTimeFormat('pt-BR', { timeStyle: 'medium' });

function ResultDetails({ result }) {
  const { data } = result;
  return (
    <>
      <dl>
        <div><dt>Gateway</dt><dd>{data.gatewayUsed}</dd></div>
        <div><dt>Tempo total</dt><dd>{data.processingTimeMs} ms</dd></div>
        <div><dt>Tentativas adicionais</dt><dd>{data.retries}</dd></div>
      </dl>
      {data.attempts.length > 0 && (
        <ol className="attempts" aria-label="Tentativas">
          {data.attempts.map((item, index) => (
            <li key={index}>
              <span>{item.gateway}</span><strong>{attemptLabels[item.outcome]}</strong>
            </li>
          ))}
        </ol>
      )}
    </>
  );
}

function History({ entries, onClear }) {
  const [status, setStatus] = useState('all');
  const [method, setMethod] = useState('all');
  const filtered = filterHistory(entries, status, method);

  return (
    <section className="panel history" aria-labelledby="history-heading">
      <div className="section-header">
        <div>
          <h2 id="history-heading">Histórico da página</h2>
          <p className="muted">Até 25 resultados nesta aba. Recarregar a página apaga a lista.</p>
        </div>
        <button type="button" className="secondary" disabled={!entries.length} onClick={onClear}>
          Limpar histórico
        </button>
      </div>
      <div className="history-filters">
        <label>Resultado
          <select value={status} onChange={(event) => setStatus(event.target.value)}>
            <option value="all">Todos</option>
            {Object.entries(statusLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
          </select>
        </label>
        <label>Método no histórico
          <select value={method} onChange={(event) => setMethod(event.target.value)}>
            <option value="all">Todos</option>
            {Object.entries(methodLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
          </select>
        </label>
      </div>
      <p role="status" className="history-count">
        {!entries.length ? 'Nenhuma simulação registrada.' :
          !filtered.length ? 'Nenhum resultado corresponde aos filtros.' :
            `Exibindo ${filtered.length} de ${entries.length} simulações.`}
      </p>
      <ul className="history-list">
        {filtered.map(({ id, time, payment, result }) => {
          const state = simulationStatus(result);
          const amount = new Intl.NumberFormat('pt-BR', { style: 'currency', currency: payment.currency }).format(payment.amount);
          return (
            <li key={id}>
              <details>
                <summary>
                  <strong>{amount}</strong>{' · '}{methodLabels[payment.method]}{' · '}
                  <time dateTime={new Date(time).toISOString()}>{timeFormat.format(time)}</time>
                  <span className={`history-status ${state === 'approved' ? 'success' : 'error'}`}>
                    {statusLabels[state]}
                  </span>
                </summary>
                {createElement(ResultDetails, { result })}
              </details>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

function Dashboard() {
  const [amount, setAmount] = useState('25,00');
  const [currency, setCurrency] = useState('BRL');
  const [method, setMethod] = useState('PIX');
  const [pending, setPending] = useState(false);
  const [reply, setReply] = useState(null);
  const [amountError, setAmountError] = useState(false);
  const [history, setHistory] = useState([]);
  const amountInput = useRef(null);
  const attempt = useRef(null);
  const busy = useRef(false);

  async function simulate(event) {
    event.preventDefault();
    if (busy.current) return;
    const value = parseAmount(amount);
    if (value === null) {
      setAmountError(true);
      amountInput.current.focus();
      return;
    }
    busy.current = true;
    if (!attempt.current) {
      attempt.current = { payment: { amount: value, currency, method }, key: crypto.randomUUID() };
    }
    setPending(true);
    setReply(null);

    try {
      const { payment, key } = attempt.current;
      const result = await requestSimulation(payment, key);
      if (!result.retryable) attempt.current = null;
      if ('data' in result) {
        const entry = { id: key, time: Date.now(), payment, result };
        setHistory((entries) => addHistory(entries, entry));
      }
      setReply(result);
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
          <form noValidate onSubmit={simulate}>
            <fieldset disabled={pending || Boolean(reply?.retryable)}>
              <div className="inputs">
                <label>Valor
                  <input type="text" inputMode="decimal" required
                    ref={amountInput}
                    aria-invalid={amountError}
                    aria-describedby="amount-hint"
                    value={amount} onChange={(event) => {
                      setAmount(event.target.value);
                      setAmountError(false);
                    }} />
                </label>
                <label>Moeda
                  <select value={currency} onChange={(event) => setCurrency(event.target.value)}>
                    <option value="BRL">BRL</option><option value="USD">USD</option><option value="EUR">EUR</option>
                  </select>
                </label>
              </div>
              <p id="amount-hint" className={amountError ? 'hint invalid' : 'hint'} role={amountError ? 'alert' : undefined}>
                {amountError ? 'Informe um valor de 0,01 a 1.000.000, com até duas casas decimais.' : 'Exemplo: 25,00.'}
              </p>
              <label>Método
                <select value={method} onChange={(event) => setMethod(event.target.value)}>
                  <option value="PIX">Pix</option><option value="CREDIT_CARD">Cartão simulado</option>
                </select>
              </label>
            </fieldset>
            <button className="submit" type="submit" disabled={pending}>
              {pending ? 'Simulando…' : reply?.retryable ? 'Tentar novamente' : 'Simular pagamento'}
            </button>
            {reply?.retryable && (
              <button className="secondary" type="button" onClick={() => {
                attempt.current = null;
                setReply(null);
              }}>
                Descartar tentativa sem resultado
              </button>
            )}
          </form>
        </section>
        <section className="panel result" aria-labelledby="result-heading">
          <h2 id="result-heading">Resultado</h2>
          <p role="status" className={reply ? `notice ${reply.data?.success ? 'success' : 'error'}` : 'empty'}>
            {pending ? 'Aguardando resposta dos gateways…' :
              reply?.error ?? (reply ? statusLabels[simulationStatus(reply)] :
                'O resultado e as tentativas aparecerão aqui após a simulação.')}
          </p>
          {reply?.data && createElement(ResultDetails, { result: reply })}
        </section>
      </div>
      {createElement(History, { entries: history, onClear: () => setHistory([]) })}
      <footer>DEMONSTRAÇÃO LOCAL <span>·</span> SEM INTEGRAÇÃO COM PROVEDORES REAIS</footer>
    </main>
  );
}

createRoot(document.getElementById('root')).render(createElement(Dashboard));