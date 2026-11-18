// Perpl perps on Monad mainnet (chain 143), https://docs.perpl.xyz. Orders travel over the authenticated
// trading WebSocket (/ws/v1/trading): the first frame is an ApiKeySignIn (mt 29) signed with an Ed25519 API
// key that has the trade scope, then OrderRequest frames (mt 22). Perpl forwards each order on chain.
// The probe is an IOC limit 3% away from mark, so it cannot fill; the clock stops at the OrdersUpdate (mt 24)
// that reports the order finished (canceled or expired), which carries the transaction hash (at.txid).
// Without a key the lane reports network time only, measured with Ping (mt 1) / Pong (mt 2).
import { createPrivateKey, sign, randomBytes } from 'node:crypto';
import { Sock, now } from './util.js';
import { MARKETS as STOCKS, MAX_NOTIONAL_USD } from './markets.js';

const HOST = 'app.perpl.xyz', CHAIN_ID = 143;
export const PERPL_EXPLORER = 'https://monadscan.com/tx/';
const PKCS8_ED25519 = Buffer.from('302e020100300506032b657004220420', 'hex');
const FINAL = new Set([4, 5, 6]); // Filled, Canceled, Expired
const LEVERAGE = 300; // hundredths: 3x, inside every market's initial margin limit
let ctxCache = null, ctxAt = 0;

export function perplCred(env) {
  const token = String(env.PERPL_API_KEY || '').trim(), secret = String(env.PERPL_API_KEY_SECRET || '').trim().replace(/^0x/i, '');
  if (!token && !secret) return { cred: null, credError: null };
  if (!token || !/^[0-9a-fA-F]{64}$/.test(secret)) return { cred: null, credError: 'PERPL_API_KEY (token) and PERPL_API_KEY_SECRET (64 hex Ed25519 private key) are both required' };
  try { return { cred: { token, key: createPrivateKey({ key: Buffer.concat([PKCS8_ED25519, Buffer.from(secret, 'hex')]), format: 'der', type: 'pkcs8' }) }, credError: null }; }
  catch { return { cred: null, credError: 'PERPL_API_KEY_SECRET could not be read as an Ed25519 key' }; }
}
// WebSocket sign-in frame: four fields joined by newlines, Ed25519 signature in base64url without padding.
export function signInFrame(cred, ts = String(Date.now()), nonce = randomBytes(16).toString('base64url')) {
  const canonical = [CHAIN_ID, 'trading-ws-signin', ts, nonce].join('\n');
  return { mt: 29, chain_id: CHAIN_ID, api_key: cred.token, timestamp: ts, nonce, signature: sign(null, Buffer.from(canonical), cred.key).toString('base64url') };
}
async function context() {
  if (!ctxCache || Date.now() - ctxAt > 600000) { const r = await fetch(`https://${HOST}/api/v1/pub/context`, { cache: 'no-store' }); if (!r.ok) throw new Error('context HTTP ' + r.status); ctxCache = await r.json(); ctxAt = Date.now(); }
  return ctxCache;
}
// A signed read (never an order): sign in on the trading socket and read the wallet snapshot.
export async function perplCheck(env) {
  const { cred, credError } = perplCred(env); if (!cred) return { ok: false, error: credError || 'no key' };
  const tw = new Sock(`wss://${HOST}/ws/v1/trading`);
  try {
    await tw.open(); const p = tw.waitFor(m => m.mt === 19 || (m.mt === 3 && m.status && m.status.code), 8000, 'perpl sign-in'); tw.send(signInFrame(cred));
    const { msg } = await p; if (msg.mt === 3) return { ok: false, status: msg.status };
    const a = (msg.as || [])[0] || null;
    return { ok: !!a, accounts: (msg.as || []).length, accountId: a ? a.id : null, lastRequest: a ? a.lfr : null, fields: a ? Object.keys(a).slice(0, 20) : [] };
  } catch (e) { return { ok: false, error: e.message }; } finally { tw.close(); }
}
const pick = (o, ks) => o && typeof o === 'object' ? Object.fromEntries(ks.filter(k => o[k] != null).map(k => [k, o[k]])) : null;

export function create(env, stock, side = 'short') {
  const buy = side === 'long', marketId = STOCKS[stock].perpl, { cred, credError } = perplCred(env);
  let md, tw, cfg, ttl = 15, mark = null, head = 0, acc = null, rq = 0;
  const pong = sock => { const p = sock.waitFor(m => m.mt === 2, 8000, 'pong'); sock.send({ mt: 1, t: Date.now() }); return p; };
  if (marketId == null) return { id: 'perpl', real: false, async connect() {}, async prepare() {}, async ping() { return 0; }, async fire() { return { basis: 'none', unlisted: true, error: `${stock} is not listed on Perpl` }; }, close() {} };
  return {
    id: 'perpl', real: false,
    async connect() {
      md = new Sock(`wss://${HOST}/ws/v1/market-data`); await md.open();
      md.on(m => { if (m.mt === 9 && m.d && m.d[marketId] && m.d[marketId].mrk) mark = m.d[marketId].mrk; if (m.mt === 100 && m.h) head = m.h; if (m.mt === 9 && m.sn) head = Math.max(head, m.sn); });
      md.send({ mt: 5, subs: [{ stream: `market-state@${CHAIN_ID}`, subscribe: true }, { stream: `heartbeat@${CHAIN_ID}`, subscribe: true }] });
      if (cred) {
        tw = new Sock(`wss://${HOST}/ws/v1/trading`); await tw.open();
        tw.on(m => { if (m.mt === 100 && m.h) head = m.h; if ((m.mt === 19 || m.mt === 21) && m.as && m.as[0]) { acc = m.as[0].id ?? acc; rq = Math.max(rq, Number(m.as[0].lfr || 0)); } });
        const snap = tw.waitFor(m => m.mt === 19 || (m.mt === 3 && m.status && m.status.code), 8000, 'perpl sign-in');
        tw.send(signInFrame(cred));
        const { msg } = await snap; if (msg.mt === 3) throw new Error('perpl sign-in refused: ' + JSON.stringify(msg.status).slice(0, 120));
      }
    },
    async prepare() {
      const c = await context(), m = (c.markets || []).find(x => x.id === marketId);
      if (!m || !m.config || !m.config.is_open) throw new Error('market ' + marketId + ' is not open');
      cfg = m.config; ttl = Math.max(5, Math.min(Number(m.order_ttl_blocks) || 15, 20) - 2);
      const end = now() + 4000; while (mark == null && now() < end) await new Promise(r => setTimeout(r, 20));
      if (mark == null) throw new Error('mark price unavailable');
      await pong(tw || md);
      this.real = !!cred && acc != null && head > 0;
    },
    async ping() { const t = now(); return (await pong(tw || md)).t - t; },
    async fire(t0) {
      const out = { basis: 'none' }; if (credError) out.keyError = credError;
      let ordP = null, myRq = null;
      if (this.real) {
        const pd = 10 ** cfg.price_decimals, sd = 10 ** cfg.size_decimals, markPx = mark / pd;
        const p = Math.round(markPx * (buy ? 0.97 : 1.03) * pd), s = Math.ceil(11 / markPx * sd);
        if (s / sd * markPx > MAX_NOTIONAL_USD) throw new Error('order size check failed');
        myRq = ++rq; out.kind = 'IOC order';
        const mine = m => m.mt === 24 && Array.isArray(m.d) && m.d.some(o => o.rq === myRq && o.acc === acc);
        // Final state: canceled, expired or filled; a rejection arrives as a StatusResponse carrying our request id.
        ordP = tw.waitFor(m => (mine(m) && m.d.some(o => o.rq === myRq && (FINAL.has(o.st) || o.r))) || (m.mt === 3 && (m.rq === myRq || m.cid === myRq) && m.status && m.status.code), 10000, 'perpl final state');
        ordP.catch(() => {});
        tw.send({ mt: 22, rq: myRq, mkt: marketId, acc, t: buy ? 1 : 2, p, s, fl: 4, lv: LEVERAGE, lb: head + ttl });
      }
      const net = await pong(tw || md); out.network = net.t - t0;
      if (ordP) {
        try {
          const { msg, t } = await ordP;
          if (msg.mt === 3) out.error = 'order rejected: ' + JSON.stringify(msg.status).slice(0, 160);
          else {
            const o = msg.d.find(x => x.rq === myRq); out.confirmed = t - t0; out.basis = 'real';
            out.status = ({ 4: 'filled', 5: 'canceled', 6: 'expired' })[o.st] || ('status ' + o.st); if (o.sr != null) out.status += ' (reason ' + o.sr + ')';
            const raw = (o.at && o.at.txid) || (o.c && o.c.txid), tx = raw ? (String(raw).startsWith('0x') ? raw : '0x' + raw) : null; // Perpl sends the hash without 0x
            out.proof = tx ? { kind: 'tx', id: tx, url: PERPL_EXPLORER + tx, where: 'Monad mainnet' + (o.at && o.at.b ? ', block ' + o.at.b : '') } : { kind: 'order', id: String(o.oid ?? myRq), where: 'Perpl order id' };
            out.reply = pick(o, ['rq', 'oid', 'mkt', 't', 'st', 'sr', 'p', 'os', 'fs', 'fl', 'lv', 'at']);
          }
        } catch (e) { out.error = e.message; }
      }
      return out;
    },
    close() { md && md.close(); tw && tw.close(); },
  };
}
