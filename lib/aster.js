// Aster perps, V3 API (the only one open to new keys). Requests are signed by an API wallet ("agent"):
// the url-encoded parameters, with nonce and signer appended, are signed as EIP-712 typed data
// (domain AsterSignTransaction, chainId 1666). With a key the probe is a real order that cannot fill:
// IOC (taker path) or GTX post-only (maker path, then cancelled). Limit prices must stay within 2% of
// mark, so the probe sits 1.5% away. Tick, step and minimum notional come from exchangeInfo.
import { privateKeyToAccount } from 'viem/accounts';
import { now, normKey } from './util.js';
import { MARKETS as STOCKS, MAX_NOTIONAL_USD } from './markets.js';

const HOST = 'https://fapi.asterdex.com';
const DOMAIN = { name: 'AsterSignTransaction', version: '1', chainId: 1666, verifyingContract: '0x0000000000000000000000000000000000000000' };
const TYPES = { Message: [{ name: 'msg', type: 'string' }] };
export const asterSigner = env => { const k = normKey(env.ASTER_SIGNER_KEY); return k ? privateKeyToAccount(k) : null; };
let seq = 0n, bareSig = false, info = null, infoAt = 0; // info: exchangeInfo, cached for 10 minutes (it is large)
const dec = x => { const t = String(x).replace(/0+$/, ''); return (t.split('.')[1] || '').length; }; // bareSig: send the signature without 0x if the API asks for that form
const nonceUs = () => String(BigInt(Date.now()) * 1000n + (seq = (seq + 1n) % 1000n));

export async function asterSign(acct, params) {
  const msg = new URLSearchParams({ ...params, nonce: nonceUs(), signer: acct.address }).toString();
  const sig = await acct.signTypedData({ domain: DOMAIN, types: TYPES, primaryType: 'Message', message: { msg } });
  return { msg, sig };
}

// A signed read (never an order): proves the signing scheme and the API wallet before any order is sent.
export async function asterBalance(env) {
  const acct = asterSigner(env); if (!acct) return { ok: false, error: 'no signer key' };
  try {
    for (let attempt = 0; ; attempt++) {
      const { msg, sig } = await asterSign(acct, {}), r = await fetch(`${HOST}/fapi/v3/balance?${msg}&signature=${bareSig ? sig.slice(2) : sig}`);
      const j = await r.json().catch(() => ({ code: r.status, msg: 'non-JSON reply' }));
      if (attempt === 0 && !Array.isArray(j) && /signature/i.test(String(j.msg || ''))) { bareSig = !bareSig; continue; }
      if (!Array.isArray(j)) return { ok: false, http: r.status, code: j.code, message: j.msg, signatureForm: bareSig ? 'bare' : '0x' };
      return { ok: true, signatureForm: bareSig ? 'bare' : '0x', balances: j.filter(b => +b.balance !== 0).map(b => ({ asset: b.asset, balance: b.balance, available: b.availableBalance })) };
    }
  } catch (e) { return { ok: false, error: e.message }; }
}

export function create(env, stock, side = 'short') {
  const buy = side === 'long', symbol = STOCKS[stock].aster.toUpperCase(), acct = asterSigner(env);
  const keyError = env.ASTER_SIGNER_KEY && !acct ? 'ASTER_SIGNER_KEY must be the API wallet private key (64 hex characters)' : null;
  let mark = null, baseline = null, flt = null; // baseline: best warm round trip seen before the race
  const ping = async () => { const t = now(); const r = await fetch(HOST + '/fapi/v3/time', { cache: 'no-store' }); await r.arrayBuffer(); if (!r.ok) throw new Error('HTTP ' + r.status); return now() - t; };
  const call = async (method, path, params) => {
    for (let attempt = 0; ; attempt++) {
      const { msg, sig } = await asterSign(acct, params), full = msg + '&signature=' + (bareSig ? sig.slice(2) : sig);
      const r = method === 'POST'
        ? await fetch(HOST + path, { method, headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: full })
        : await fetch(HOST + path + '?' + full, { method });
      const t = now(), j = await r.json().catch(() => ({ code: r.status, msg: 'non-JSON reply' }));
      if (attempt === 0 && j && j.code && /signature/i.test(String(j.msg || ''))) { bareSig = !bareSig; continue; } // try the other signature form once
      return { t, j, http: r.status };
    }
  };
  const order = tif => {
    const tick = +flt.PRICE_FILTER.tickSize, step = +flt.LOT_SIZE.stepSize, minN = +(flt.MIN_NOTIONAL && flt.MIN_NOTIONAL.notional || 5);
    const px = (Math.round(mark * (buy ? 0.985 : 1.015) / tick) * tick).toFixed(dec(flt.PRICE_FILTER.tickSize));
    const q = Math.max(+flt.LOT_SIZE.minQty, Math.ceil(Math.max(6, minN * 1.2) / mark / step) * step), qty = q.toFixed(dec(flt.LOT_SIZE.stepSize));
    if (q * mark > MAX_NOTIONAL_USD) throw new Error('order size check failed: ' + qty + ' ' + symbol);
    return call('POST', '/fapi/v3/order', { symbol, side: buy ? 'BUY' : 'SELL', type: 'LIMIT', timeInForce: tif, quantity: qty, price: px, newOrderRespType: 'RESULT' });
  };
  const describe = j => j.status || (j.code != null ? `${j.code} ${j.msg || ''}`.trim() : 'no status');
  return {
    id: 'aster', real: false,
    async connect() { await ping(); },
    async prepare() {
      // The ping and the order leave at the same instant, so two connections must already be open and warm.
      const warm = await Promise.all([ping(), ping()]); const again = await Promise.all([ping(), ping()]);
      baseline = Math.min(...warm, ...again);
      if (!acct) return;
      if (!info || Date.now() - infoAt > 600000) { info = await (await fetch(`${HOST}/fapi/v3/exchangeInfo`)).json(); infoAt = Date.now(); }
      const si = (info.symbols || []).find(x => x.symbol === symbol); if (!si) throw new Error(symbol + ' not listed');
      flt = Object.fromEntries(si.filters.map(f => [f.filterType, f]));
      const j = await (await fetch(`${HOST}/fapi/v3/premiumIndex?symbol=${symbol}`, { cache: 'no-store' })).json();
      mark = +j.markPrice; if (!(mark > 0)) throw new Error('mark price unavailable');
      this.real = true;
    },
    ping,
    async fire(t0) {
      const out = { basis: 'none' }; if (keyError) out.keyError = keyError;
      const netP = ping(), ordP = this.real ? order('IOC') : null;
      if (ordP) ordP.catch(() => {});
      const tn = now(); out.network = (await netP) + (tn - t0);
      if (ordP) {
        try {
          const { t, j } = await ordP; out.kind = 'IOC order'; out.status = describe(j);
          if (j.orderId != null) { out.confirmed = t - t0; out.basis = 'real'; out.proof = { kind: 'order', id: String(j.orderId), where: 'Aster order id. The API returns no transaction hash for an order' }; } else out.error = 'order rejected: ' + out.status;
          // A ping slower than the whole order means it had to open a connection: fall back to the warm baseline.
          if (out.confirmed != null && out.network >= out.confirmed && baseline != null) { out.network = baseline; out.networkFrom = 'warm-up'; }
        } catch (e) { out.error = e.message; }
      }
      return out;
    },
    async maker(t1) {
      const { t, j } = await order('GTX'), out = { ms: t - t1, status: describe(j) };
      if (j.orderId != null && j.status !== 'EXPIRED' && j.status !== 'CANCELED') { const c = await call('DELETE', '/fapi/v3/order', { symbol, orderId: String(j.orderId) }); out.cancel = describe(c.j); }
      return out;
    },
    close() {},
  };
}
