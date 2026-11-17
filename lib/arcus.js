// Arcus perps. With an Ed25519 API key the probe is a real order that cannot fill: a sell priced 3%
// above mark, sent IOC (taker path, which Arcus holds behind its speed bump) or ALO (maker path, then
// cancelled). Arcus answers 202 ACK first; the definitive state arrives on the public `orders` channel.
// Signing follows docs.arcus.xyz/api-reference/authentication (Scheme 1, typed payload).
import { createPrivateKey, createPublicKey, sign } from 'node:crypto';
import { Sock, now } from './util.js';
import { MARKETS as STOCKS, MAX_NOTIONAL_USD } from './markets.js';

const PKCS8_ED25519 = Buffer.from('302e020100300506032b657004220420', 'hex');
export function arcusKey(secretHex) {
  const key = createPrivateKey({ key: Buffer.concat([PKCS8_ED25519, Buffer.from(secretHex.replace(/^0x/, ''), 'hex')]), format: 'der', type: 'pkcs8' });
  return { key, apiKey: createPublicKey(key).export({ type: 'spki', format: 'der' }).subarray(-32).toString('hex') };
}
export const arcusSign = (key, payload) => sign(null, Buffer.from(payload), key).toString('hex');
// Canonical Scheme 1 payloads: fixed alphabetical keys, no whitespace, integers unquoted.
export const placePayload = o => `{"ad":"${o.ad}","ai":${o.ai},"ct":${o.ct},"g":${o.g},"m":${o.m},"op":1,"p":${o.p},"q":${o.q},"r":0,"s":${o.s},"t":${o.t},"v":1}`;
export const cancelPayload = o => `{"ad":"${o.ad}","ai":${o.ai},"ct":${o.ct},"id":"${o.id}","m":${o.m},"op":2,"v":1}`;
const TIF = { GTT: 0, FOK: 1, IOC: 2, ALO: 3 };
const decimals = s => (String(s).split('.')[1] || '').length;
let nsBump = 0n;
const nowNs = () => BigInt(Date.now()) * 1000000n + (nsBump = (nsBump + 1n) % 1000000n);

// Reads the Arcus credentials. A malformed value is reported, never thrown, so one bad key cannot break a race.
export function arcusCred(env) {
  const secret = String(env.ARCUS_API_SECRET || '').trim().replace(/^0x/i, ''), address = String(env.ARCUS_ADDRESS || '').trim();
  if (!secret && !address) return { cred: null, credError: null };
  if (!/^[0-9a-fA-F]{64}$/.test(secret)) return { cred: null, credError: 'ARCUS_API_SECRET must be the 64 hex character API Signing Key' };
  if (!/^0x[0-9a-fA-F]{40}$/.test(address)) return { cred: null, credError: 'ARCUS_ADDRESS must be the 0x wallet address' };
  try { return { cred: { ...arcusKey(secret), address, ai: Number(String(env.ARCUS_ACCOUNT_INDEX || '0').trim()) || 0 }, credError: null }; }
  catch (e) { return { cred: null, credError: 'ARCUS_API_SECRET could not be read as an Ed25519 key' }; }
}

const pick = (o, ks) => o && typeof o === 'object' ? Object.fromEntries(ks.filter(k => o[k] != null).map(k => [k, o[k]])) : null;
export function create(env, stock, side = 'short') {
  const buy = side === 'long'; // long: a buy priced below the market, short: a sell priced above it. Neither can fill.
  const host = env.ARCUS_ENV === 'testnet' ? 'api.testnet.arcus.xyz' : 'api.arcus.xyz', market = STOCKS[stock].arcus;
  const { cred, credError } = arcusCred(env);
  let ws, mkt, reqId = 0; const frames = [];
  const timeUrl = `https://${host}/v1/time`;
  const httpPing = async () => { const t = now(); const r = await fetch(timeUrl, { cache: 'no-store' }); await r.arrayBuffer(); if (!r.ok) throw new Error('HTTP ' + r.status); return now() - t; };
  const post = async (type, body, payload, ts) => {
    const id = ++reqId, p = ws.waitFor(m => m.id === id && m.type !== 'subscribed', 12000, type + ' reply');
    ws.sendRaw(JSON.stringify({ type: 'post', id, request: { type, payload: { ...body, timestamp: '__TS__' }, apiKey: cred.apiKey, timestamp: String(ts), signature: arcusSign(cred.key, payload) } }).replace('"__TS__"', String(ts)));
    return p;
  };
  // Resolves when the public orders channel first mentions this order id, with the status it carries.
  // reply: the order as Arcus reported it on the public stream, shown on the page as the venue's own record
  const read = f => { let c = null; try { c = JSON.parse(f.s).contents; } catch {} return { t: f.t, status: (f.s.match(/"status":"([A-Z_]+)"/) || [])[1] || 'UPDATE', frame: f.s.slice(0, 360), reply: pick(c, ['orderId', 'marketDisplayName', 'side', 'type', 'timeInForce', 'status', 'price', 'originalSize', 'filledSize', 'createdAt', 'updatedAt']) }; };
  const seen = async (orderId, timeout = 6000) => {
    const hit = () => frames.find(f => f.s.includes(orderId));
    const end = now() + timeout; let f = hit();
    while (!f && now() < end) { await new Promise(r => setTimeout(r, 5)); f = hit(); }
    return f ? read(f) : null;
  };
  const place = async tif => {
    const tick = mkt.tickSize, step = mkt.stepSize;
    const pTicks = Math.round(+mkt.markPrice * (buy ? 0.97 : 1.03) / +tick), price = (pTicks * +tick).toFixed(decimals(tick));
    const target = Math.max(6, (+mkt.minOrderNotional || 0) * 1.1); // a little over the venue minimum
    const qInt = Math.max(Math.ceil(+mkt.minOrderSize / +step - 1e-9), Math.ceil(target / +mkt.markPrice / +step)), qty = qInt * +step;
    const quantity = qty.toFixed(Math.min(decimals(step), 8)).replace(/0+$/, '').replace(/\.$/, '');
    if (qty * +mkt.markPrice > MAX_NOTIONAL_USD) throw new Error('order size check failed: ' + quantity + ' ' + market);
    const ts = nowNs(), gtUs = BigInt(Date.now() + 40 * 86400000) * 1000n;
    const payload = placePayload({ ad: cred.address.toLowerCase(), ai: cred.ai, ct: ts, g: gtUs * 1000n, m: mkt.marketId, p: pTicks, q: qInt, s: buy ? 0 : 1, t: TIF[tif] });
    const body = { address: cred.address, accountIndex: cred.ai, marketId: mkt.marketId, orderSide: buy ? 'BUY' : 'SELL', orderType: 'LIMIT', quantity, price, timeInForce: tif, goodTilTime: String(gtUs) };
    const { msg, t } = await post('placeOrder', body, payload, ts);
    const orderId = msg.result && msg.result.orderId;
    return { t, http: msg.status, orderId, ack: (msg.result && msg.result.status) || (msg.error && (msg.error.message || msg.error.type)) || 'no result' };
  };
  return {
    id: 'arcus', real: false,
    async connect() { ws = new Sock(`wss://${host}/v1/ws`); await ws.open(); },
    async prepare() {
      const r = await fetch(`https://${host}/v1/markets`); const j = await r.json();
      mkt = (Array.isArray(j) ? j : j.markets || []).find(m => m.marketDisplayName === market);
      if (!mkt) throw new Error(market + ' not listed');
      this.real = !!cred;
      if (cred) {
        ws.on((m, t) => { if (m.channel === 'orders' && m.type === 'channel_data') frames.push({ t, s: JSON.stringify(m) }); });
        const subscribed = ws.waitFor(m => m.channel === 'orders' && (m.type === 'subscribed' || m.type === 'degraded' || m.type === 'error'), 3000, 'orders subscribe').catch(() => null);
        ws.send({ type: 'subscribe', channel: 'orders', id: cred.address, accountIndex: cred.ai, market });
        await subscribed; // an order sent before the stream is live would never show up on it
      }
      await httpPing();
    },
    ping: httpPing,
    async fire(t0) {
      const out = { basis: 'none' }; if (credError) out.keyError = credError;
      const netP = httpPing(), ordP = this.real ? place('IOC') : null;
      if (ordP) ordP.catch(() => {});
      out.network = (await netP);
      if (ordP) {
        try {
          const r = await ordP; out.ack = r.t - t0; out.ackStatus = `${r.http} ${r.ack}`; out.kind = 'IOC order';
          // The ACK travels on the order's own socket. If the separate HTTP time ping was unlucky, the ACK is the better network figure.
          if (r.orderId && out.ack < out.network) out.network = out.ack;
          const fin = r.orderId ? await seen(r.orderId) : null;
          // Matching is off-chain, but Arcus lists every order of an account, cancelled ones included, on a public endpoint.
          if (r.orderId) out.proof = { kind: 'order', id: r.orderId, url: `https://${host}/v1/orders?address=${cred.address}&accountIndex=${cred.ai}`, where: 'Arcus public order list for our account. Search it for this order id' };
          if (fin) { out.confirmed = fin.t - t0; out.status = fin.status; out.basis = 'real'; out.frame = fin.frame; out.reply = fin.reply; }
          else if (r.orderId) { out.status = 'acknowledged, final state not seen'; out.basis = 'none'; }
          else out.error = 'order rejected: ' + r.ack;
        } catch (e) { out.error = e.message; }
      }
      return out;
    },
    async maker(t1) {
      const r = await place('ALO'), out = { ack: r.t - t1, ackStatus: `${r.http} ${r.ack}` };
      if (!r.orderId) return out;
      const fin = await seen(r.orderId); if (fin) { out.ms = fin.t - t1; out.status = fin.status; } else { out.ms = out.ack; out.status = 'ACK only'; }
      const ts = nowNs(), payload = cancelPayload({ ad: cred.address.toLowerCase(), ai: cred.ai, ct: ts, id: r.orderId, m: mkt.marketId });
      const c = await post('cancelOrder', { address: cred.address, accountIndex: cred.ai, marketId: mkt.marketId, kind: 'orderId', orderId: r.orderId }, payload, ts);
      out.cancel = (c.msg.result && c.msg.result.status) || (c.msg.error && c.msg.error.message) || String(c.msg.status);
      return out;
    },
    close() { ws && ws.close(); },
  };
}
