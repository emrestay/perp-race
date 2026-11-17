// Lighter perps (mainnet). Orders are signed with Lighter's own scheme, so the official signer from
// elliottech/lighter-go, compiled to WebAssembly, lives in ./lighter-signer. With an API key the probe is a
// real order that cannot fill: IOC (taker path; standard accounts carry a published 300 ms taker latency) or
// post-only (maker path, then cancelled). The API answers "accepted" first; the definitive state arrives on
// the private account_all_orders channel. Without a key the lane shows network + the published 300 ms.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Sock, now } from './util.js';
import { MARKETS as STOCKS, MAX_NOTIONAL_USD } from './markets.js';

export const LIGHTER_TAKER_DOC_MS = 300; // docs.lighter.xyz/trading/trading-fees (standard account)
const HOST = 'mainnet.zklighter.elliot.ai', CHAIN_ID = 304;
const TIF = { IOC: 0, GTT: 1, POST_ONLY: 2 };

let signerP = null;
export function loadSigner() {
  return signerP ??= (async () => {
    const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), 'lighter-signer');
    await import(pathToFileURL(path.join(dir, 'wasm_exec.js')).href); // defines globalThis.Go
    const go = new globalThis.Go();
    const { instance } = await WebAssembly.instantiate(fs.readFileSync(path.join(dir, 'lighter-signer.wasm')), go.importObject);
    go.run(instance); // not awaited: the Go runtime stays alive
    return globalThis;
  })();
}
const check = r => { if (r && r.error) throw new Error('lighter signer: ' + r.error); return r; };

// Reads the Lighter credentials. A malformed value is reported, never thrown.
export function lighterCred(env) {
  const key = String(env.LIGHTER_API_PRIVATE_KEY || '').trim(), ai = String(env.LIGHTER_ACCOUNT_INDEX || '').trim(), ki = String(env.LIGHTER_API_KEY_INDEX || '').trim();
  if (!key && !ai && !ki) return { cred: null, credError: null };
  if (!/^(0x)?[0-9a-fA-F]{80}$/.test(key)) return { cred: null, credError: 'LIGHTER_API_PRIVATE_KEY must be the API private key (80 hex characters)' };
  if (!/^\d+$/.test(ai)) return { cred: null, credError: 'LIGHTER_ACCOUNT_INDEX must be a number' };
  if (!/^\d+$/.test(ki)) return { cred: null, credError: 'LIGHTER_API_KEY_INDEX must be a number' };
  return { cred: { key: key.startsWith('0x') ? key : '0x' + key, ai: Number(ai), ki: Number(ki) }, credError: null };
}

const pick = (o, ks) => o && typeof o === 'object' ? Object.fromEntries(ks.filter(k => o[k] != null).map(k => [k, o[k]])) : null;
export function create(env, stock, side = 'short') {
  const buy = side === 'long', marketId = STOCKS[stock].lighter, { cred, credError } = lighterCred(env);
  let ws, L, mkt, nonce = null, coiSeq = 0; const frames = [];
  const api = async p => { const r = await fetch(`https://${HOST}${p}`, { cache: 'no-store' }); return r.json(); };
  const pong = () => { const p = ws.waitFor(m => m.type === 'pong', 8000, 'pong'); ws.send({ type: 'ping' }); return p; };
  const nextNonce = async () => { const r = await api(`/api/v1/nextNonce?account_index=${cred.ai}&api_key_index=${cred.ki}`); if (r.nonce == null) throw new Error('nextNonce: ' + (r.message || JSON.stringify(r).slice(0, 120))); return r.nonce; };
  const sendTx = async tx => {
    const r = await fetch(`https://${HOST}/api/v1/sendTx`, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ tx_type: String(tx.txType), tx_info: tx.txInfo }) });
    const t = now(), j = await r.json().catch(() => ({ code: r.status, message: 'non-JSON reply' }));
    return { t, j };
  };
  const read = f => ({ t: f.t, status: (f.s.match(/"status":"([A-Za-z_\-]+)"/) || [])[1] || 'update', frame: f.s.slice(0, 360) });
  const seen = async (coi, timeout = 6000) => {
    const key = String(coi), hit = () => frames.find(f => f.s.includes(key)), end = now() + timeout; let f = hit();
    while (!f && now() < end) { await new Promise(r => setTimeout(r, 5)); f = hit(); }
    if (!f) return null;
    const r = read(f); try { const os = Object.values(JSON.parse(f.s).orders || {}).flat(); r.reply = pick(os.find(o => String(o.client_order_index) === key), ['order_index', 'client_order_index', 'market_index', 'is_ask', 'type', 'time_in_force', 'status', 'price', 'initial_base_amount', 'filled_base_amount', 'timestamp']); } catch {}
    return r;
  };
  const sign = (tif, coi) => {
    const px = +mkt.mark_price * (buy ? 0.97 : 1.03), sd = 10 ** mkt.size_decimals, pd = 10 ** mkt.price_decimals;
    const qty = Math.max(+mkt.min_base_amount, Math.ceil(11 / +mkt.mark_price * sd) / sd);
    if (qty * +mkt.mark_price > MAX_NOTIONAL_USD) throw new Error('order size check failed');
    return check(L.SignCreateOrder(marketId, coi, Math.round(qty * sd), Math.round(px * pd), buy ? 0 : 1, 0, tif, 0, 0,
      tif === TIF.IOC ? 0 : Date.now() + 3600e3, 0, 0, 0, 0, 0, 0, nonce++, cred.ki, cred.ai));
  };
  const newCoi = () => (Date.now() % 2000000000) + (coiSeq++);
  return {
    id: 'lighter', real: false,
    async connect() { ws = new Sock(`wss://${HOST}/stream`); await ws.open(); await new Promise(r => setTimeout(r, 60)); },
    async prepare() {
      await pong();
      if (!cred) return;
      L = await loadSigner();
      check(L.CreateClient('', cred.key, CHAIN_ID, cred.ki, cred.ai));
      const d = await api(`/api/v1/orderBookDetails?market_id=${marketId}`); mkt = (d.order_book_details || [])[0];
      if (!mkt || !(+mkt.mark_price > 0)) throw new Error('market details unavailable');
      const { authToken } = check(L.CreateAuthToken(0, cred.ki, cred.ai));
      ws.on((m, t) => { if (typeof m.channel === 'string' && m.channel.startsWith('account_all_orders')) frames.push({ t, s: JSON.stringify(m) }); });
      ws.send({ type: 'subscribe', channel: `account_all_orders/${cred.ai}`, auth: authToken });
      nonce = await nextNonce();
      this.real = true;
    },
    async ping() { const t = now(); return (await pong()).t - t; },
    async fire(t0) {
      const out = { basis: 'none' }; if (credError) out.keyError = credError;
      const pongP = pong();
      let ordP = null, coi = null;
      if (this.real) { coi = newCoi(); ordP = sendTx(sign(TIF.IOC, coi)); ordP.catch(() => {}); }
      out.network = (await pongP).t - t0;
      if (ordP) {
        try {
          const { t, j } = await ordP; out.ack = t - t0; out.ackStatus = `${j.code} ${j.message || ''}`.trim(); out.kind = 'IOC order';
          if (j.predicted_execution_time_ms != null) out.predictedMs = j.predicted_execution_time_ms;
          // Lighter's public API returns the transaction of an order that did not trade for a few minutes only.
          if (j.tx_hash) out.proof = { kind: 'tx', id: j.tx_hash, url: `https://${HOST}/api/v1/tx?by=hash&value=${j.tx_hash}`, short: true, where: 'Lighter API record of the transaction. Lighter keeps it for a few minutes only' };
          if (j.code !== 200) { out.error = 'order rejected: ' + out.ackStatus; }
          else { const fin = await seen(coi); if (fin) { out.confirmed = fin.t - t0; out.status = fin.status; out.frame = fin.frame; out.reply = fin.reply; out.basis = 'real'; } else { out.status = 'accepted, final state not seen'; out.noFinal = true; } } // accepted is not confirmed
        } catch (e) { out.error = e.message; }
      }
      if (out.confirmed == null && !out.error && !out.noFinal) { out.confirmed = out.network + LIGHTER_TAKER_DOC_MS; out.basis = 'docs'; out.docsMs = LIGHTER_TAKER_DOC_MS; }
      return out;
    },
    async maker() {
      nonce = await nextNonce(); // a rejected transaction may not consume its nonce, so read it again
      const coi = newCoi(), t1 = now(), { t, j } = await sendTx(sign(TIF.POST_ONLY, coi)), out = { ack: t - t1, ackStatus: `${j.code} ${j.message || ''}`.trim() };
      if (j.code !== 200) return out;
      const fin = await seen(coi); if (fin) { out.ms = fin.t - t1; out.status = fin.status; } else { out.ms = out.ack; out.status = 'accepted only'; }
      nonce = await nextNonce();
      const c = await sendTx(check(L.SignCancelOrder(marketId, coi, 0, nonce++, cred.ki, cred.ai))); out.cancel = `${c.j.code} ${c.j.message || ''}`.trim();
      return out;
    },
    close() { ws && ws.close(); },
  };
}
