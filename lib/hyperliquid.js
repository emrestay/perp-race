// Hyperliquid perps (main dex; a coin written "dex:COIN" is looked up on that HIP-3 dex). With an API (agent) wallet key the probe is a real order that
// cannot fill: a sell priced 3% above mid, sent IOC (taker path) or ALO (maker path, then cancelled).
// Without a key the lane falls back to network + the 200 ms median Hyperliquid publishes.
import { privateKeyToAccount } from 'viem/accounts';
import { keccak256, concat, toHex } from 'viem';
import { Sock, now, msgpack, normKey } from './util.js';
import { MARKETS as STOCKS, MAX_NOTIONAL_USD } from './markets.js';

const HOSTS = {
  mainnet: { ws: 'wss://api.hyperliquid.xyz/ws', http: 'https://api.hyperliquid.xyz', blocks: 'wss://rpc.hyperliquid.xyz/ws' },
  testnet: { ws: 'wss://api.hyperliquid-testnet.xyz/ws', http: 'https://api.hyperliquid-testnet.xyz', blocks: null },
};
export const HL_DOC_MS = 200; // hyperliquid.gitbook.io/hyperliquid-docs/hypercore/overview

export async function signL1(agent, action, nonce, mainnet = true) {
  const n = new Uint8Array(8); new DataView(n.buffer).setBigUint64(0, BigInt(nonce));
  const connectionId = keccak256(concat([toHex(msgpack(action)), toHex(n), '0x00'])); // 0x00: no vault address
  const sig = await agent.signTypedData({
    domain: { name: 'Exchange', version: '1', chainId: 1337, verifyingContract: '0x0000000000000000000000000000000000000000' },
    types: { Agent: [{ name: 'source', type: 'string' }, { name: 'connectionId', type: 'bytes32' }] },
    primaryType: 'Agent', message: { source: mainnet ? 'a' : 'b', connectionId },
  });
  return { r: sig.slice(0, 66), s: '0x' + sig.slice(66, 130), v: parseInt(sig.slice(130, 132), 16) };
}
// Hyperliquid price rule: at most 5 significant figures and at most (6 - szDecimals) decimals.
export const hlPrice = (px, szDecimals) => String(Number(Number(px.toPrecision(5)).toFixed(Math.max(0, 6 - szDecimals))));
export const hlSize = (sz, szDecimals) => String(Number(sz.toFixed(szDecimals)));

export const agentOf = env => { const k = normKey(env.HL_AGENT_KEY); return k ? privateKeyToAccount(k) : null; };

export function create(env, stock, side = 'short') {
  const buy = side === 'long'; // long: a buy priced below the market, short: a sell priced above it. Neither can fill.
  const net = env.HL_ENV === 'testnet' ? 'testnet' : 'mainnet', H = HOSTS[net], coin = STOCKS[stock].hl, DEX = coin.includes(':') ? coin.split(':')[0] : null;
  const agent = agentOf(env);
  let ws, blocks, asset, szDecimals, mid, reqId = 0, lastNonce = 0, master = null, firedAt = 0;
  const info = async body => { const r = await fetch(H.http + '/info', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }); if (!r.ok) throw new Error('info HTTP ' + r.status); return r.json(); };
  const pong = () => { const p = ws.waitFor(m => m.channel === 'pong', 8000, 'pong'); ws.send({ method: 'ping' }); return p; };
  const post = async action => {
    const nonce = lastNonce = Math.max(Date.now(), lastNonce + 1), signature = await signL1(agent, action, nonce, net === 'mainnet');
    const id = ++reqId, p = ws.waitFor(m => m.channel === 'post' && m.data && m.data.id === id, 12000, 'order reply');
    ws.send({ method: 'post', id, request: { type: 'action', payload: { action, nonce, signature, vaultAddress: null } } });
    const { msg, t } = await p, resp = msg.data.response;
    if (resp.type === 'error') return { t, status: 'rejected: ' + String(resp.payload).slice(0, 160) };
    const st = resp.payload && resp.payload.response && resp.payload.response.data && resp.payload.response.data.statuses ? resp.payload.response.data.statuses[0] : null;
    if (st && st.resting) return { t, status: 'resting', oid: st.resting.oid };
    if (st && st.filled) return { t, status: 'filled', oid: st.filled.oid };
    if (st && st.error) return { t, status: String(st.error).slice(0, 160) };
    return { t, status: (resp.payload && resp.payload.status) || 'ok' };
  };
  const order = tif => {
    const px = hlPrice(mid * (buy ? 0.97 : 1.03), szDecimals), unit = 10 ** szDecimals, sz = hlSize(Math.ceil(11 / mid * unit) / unit, szDecimals);
    if (+sz * mid > MAX_NOTIONAL_USD) throw new Error('order size check failed: ' + sz + ' ' + coin);
    return post({ type: 'order', orders: [{ a: asset, b: buy, p: px, s: sz, r: false, t: { limit: { tif } } }], grouping: 'na' });
  };
  return {
    id: 'hyperliquid', real: false,
    async connect() {
      ws = new Sock(H.ws); await ws.open();
      if (H.blocks) { try { blocks = new Sock(H.blocks); await blocks.open(); blocks.send({ method: 'subscribe', subscription: { type: 'explorerBlock' } }); } catch { blocks = null; } }
    },
    async prepare() {
      const q = DEX ? { dex: DEX } : {}, [dexs, meta, mids] = await Promise.all([DEX ? info({ type: 'perpDexs' }) : [], info({ type: 'meta', ...q }), info({ type: 'allMids', ...q })]);
      const di = DEX ? dexs.findIndex(d => d && d.name === DEX) : 0, ai = meta.universe.findIndex(u => u.name === coin);
      if (di < 0 || ai < 0) throw new Error(coin + ' not listed');
      // main dex: the asset id is the index in the universe; HIP-3: 100000 + dex * 10000 + index
      asset = DEX ? 100000 + di * 10000 + ai : ai; szDecimals = meta.universe[ai].szDecimals; mid = +mids[coin];
      this.real = !!agent && mid > 0;
      if (agent) { try { const role = await info({ type: 'userRole', user: agent.address }); master = role && role.data && role.data.user || null; } catch {} }
      await pong();
    },
    async ping() { const t = now(); return (await pong()).t - t; },
    async fire(t0) {
      const out = { basis: 'none' }; firedAt = Date.now();
      const pongP = pong(), orderP = this.real ? order('Ioc') : null;
      if (orderP) orderP.catch(() => {});
      const pg = await pongP; out.network = pg.t - t0;
      const blockP = blocks ? new Promise(res => { const off = blocks.on((m, t) => { if (Array.isArray(m) && m.length && t >= pg.t) { off(); res(t); } }); setTimeout(() => { off(); res(null); }, 3000); }) : Promise.resolve(null);
      if (orderP) { try { const r = await orderP; out.confirmed = r.t - t0; out.basis = 'real'; out.kind = 'IOC order'; out.status = r.status; } catch (e) { out.error = e.message; } }
      const tb = await blockP; if (tb != null) out.floor = tb - t0;
      if (out.confirmed == null) { out.confirmed = out.network + HL_DOC_MS; out.basis = 'docs'; out.docsMs = HL_DOC_MS; }
      return out;
    },
    async maker(t1) {
      const r = await order('Alo'), out = { ms: r.t - t1, status: r.status };
      if (r.oid != null) { const c = await post({ type: 'cancel', cancels: [{ a: asset, o: r.oid }] }); out.cancel = c.status; }
      return out;
    },
    // The order is an L1 transaction. Find it in Hyperliquid's public explorer by account and time.
    async proof() {
      if (!this.real || !master || net !== 'mainnet') return null;
      for (let i = 0; i < 4; i++) {
        try {
          const r = await fetch('https://rpc.hyperliquid.xyz/explorer', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ type: 'userDetails', user: master }) });
          const tx = ((await r.json()).txs || []).filter(t => t.time >= firedAt - 2000 && t.action && t.action.type === 'order' && JSON.stringify(t.action).includes('"Ioc"')).sort((a, b) => a.time - b.time)[0];
          if (tx) return { kind: 'tx', id: tx.hash, url: 'https://app.hyperliquid.xyz/explorer/tx/' + tx.hash, where: 'Hyperliquid L1, block ' + tx.block };
        } catch {}
        await new Promise(res => setTimeout(res, 500));
      }
      return null;
    },
    close() { ws && ws.close(); blocks && blocks.close(); },
  };
}
