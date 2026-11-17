// RISEx perps on RISE Chain (mainnet, chain 4153). Orders are on-chain: the API builds the transaction
// from a per-action EIP-712 permit ("VerifyWitness") signed by a registered session key (the API wallet),
// pays the gas and replies after execution with the tx hash and, for IOC orders, the fill result.
// Spec: https://developer.rise.trade/reference/integration (order packing, action hash, permit, nonces).
// With a key the probe is a real order that cannot fill: an IOC limit 1.5% away from mark (the match
// price band is 2% on some markets). Markets that only accept post-only orders get a post-only limit
// instead, which rests and is cancelled right after (untimed).
import { privateKeyToAccount } from 'viem/accounts';
import { keccak256, toBytes, encodeAbiParameters, getAddress } from 'viem';
import { now, normKey } from './util.js';
import { MARKETS as STOCKS, MAX_NOTIONAL_USD } from './markets.js';

const HOST = 'https://api.rise.trade';
export const RISEX_EXPLORER = 'https://explorer.risechain.com/tx/';
const WITNESS = { VerifyWitness: [
  { name: 'account', type: 'address' }, { name: 'target', type: 'address' }, { name: 'hash', type: 'bytes32' },
  { name: 'nonceAnchor', type: 'uint48' }, { name: 'nonceBitmap', type: 'uint8' }, { name: 'deadline', type: 'uint32' }] };
const PLACE = keccak256(toBytes('RISE_PERPS_PLACE_ORDER_V1')), CANCEL = keccak256(toBytes('RISE_PERPS_CANCEL_ORDER_V1'));

export function risexCred(env) {
  const k = normKey(env.RISEX_SIGNER_KEY), a = String(env.RISEX_ACCOUNT || '').trim();
  if (!k || !/^0x[0-9a-fA-F]{40}$/.test(a)) return null;
  return { signer: privateKeyToAccount(k), account: getAddress(a) };
}
const getJ = async path => { const r = await fetch(HOST + path, { cache: 'no-store' }); const j = await r.json().catch(() => ({})); if (!r.ok) throw new Error(`${path} HTTP ${r.status}`); return j.data ?? j; };

// uint88: [87:70] marketId [69:38] sizeSteps [37:14] priceTicks [13:6] flags [5:1] version=1
export function packOrder({ marketId, sizeSteps, priceTicks, sell, postOnly, limit, tif }) {
  const flags = BigInt((sell ? 1 : 0) | (postOnly ? 2 : 0) | ((limit ? 1 : 0) << 5) | ((tif & 3) << 6));
  return (BigInt(marketId) << 70n) | (BigInt(sizeSteps) << 38n) | (BigInt(priceTicks) << 14n) | (flags << 6n) | (1n << 1n);
}
export const placeHash = orderData => keccak256(encodeAbiParameters(
  [{ type: 'bytes32' }, { type: 'uint8' }, { type: 'uint88' }, { type: 'uint16' }, { type: 'uint64' }, { type: 'uint16' }], [PLACE, 1, orderData, 0, 0n, 0]));
const cancelHash = (marketId, restingId) => keccak256(encodeAbiParameters([{ type: 'bytes32' }, { type: 'uint256' }, { type: 'uint256' }], [CANCEL, BigInt(marketId), BigInt(restingId)]));

export async function risexPermit(cred, domain, router, hash, anchor, bit) {
  const deadline = Math.floor(Date.now() / 1000) + 300;
  const sig = await cred.signer.signTypedData({ domain, types: WITNESS, primaryType: 'VerifyWitness',
    message: { account: cred.account, target: router, hash, nonceAnchor: BigInt(anchor), nonceBitmap: bit, deadline } });
  return { account: cred.account, signer: cred.signer.address, nonce_anchor: String(anchor), nonce_bitmap_index: bit, deadline,
    signature: Buffer.from(sig.slice(2), 'hex').toString('base64') }; // permit signatures travel as base64 (65 bytes r||s||v)
}

export function create(env, stock, side = 'short') {
  const buy = side === 'long', marketId = STOCKS[stock].risex, cred = risexCred(env);
  const keyError = (env.RISEX_SIGNER_KEY || env.RISEX_ACCOUNT) && !cred ? 'RISEX_SIGNER_KEY (64 hex) and RISEX_ACCOUNT (0x address) are both required' : null;
  let domain, router, mkt, mark, anchor, bit, baseline = null, resting = null;
  const ping = async () => { const t = now(); const r = await fetch(HOST + '/v1/auth/eip712-domain', { cache: 'no-store' }); await r.arrayBuffer(); if (!r.ok) throw new Error('HTTP ' + r.status); return now() - t; };
  const nextBit = () => { const b = bit; bit = bit >= 207 ? 0 : bit + 1; if (b === 207) anchor += 1; return b; };
  const post = async (path, body) => {
    const r = await fetch(HOST + path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    const t = now(), j = await r.json().catch(() => ({ message: 'non-JSON reply, HTTP ' + r.status }));
    return { t, j, http: r.status };
  };
  if (marketId == null) return { id: 'risex', real: false, async connect() {}, async prepare() {}, ping, async fire() { return { basis: 'none', unlisted: true, error: `${stock} is not listed on RISEx` }; }, close() {} };
  return {
    id: 'risex', real: false,
    async connect() { await ping(); },
    async prepare() {
      const warm = await Promise.all([ping(), ping()]); const again = await Promise.all([ping(), ping()]);
      baseline = Math.min(...warm, ...again);
      if (!cred) return;
      const [d, cfg, m, ns] = await Promise.all([getJ('/v1/auth/eip712-domain'), getJ('/v1/system/config'), getJ('/v1/markets'), getJ('/v1/nonce-state/' + cred.account)]);
      domain = { name: d.name, version: d.version, chainId: Number(d.chain_id), verifyingContract: getAddress(d.verifying_contract) };
      router = getAddress(cfg.addresses.router);
      mkt = (m.markets || m).find(x => String(x.market_id) === String(marketId)); if (!mkt) throw new Error('market ' + marketId + ' missing');
      if (!mkt.active || mkt.reduce_only) throw new Error('market not open for new orders');
      mark = +mkt.mark_price; if (!(mark > 0)) throw new Error('mark price unavailable');
      // Fresh anchor (current + 1) and a random bit: two servers sharing one account rarely pick the same pair.
      anchor = Number(ns.nonce_anchor) + 1; bit = Math.floor(Math.random() * 200);
      this.real = true;
    },
    ping,
    async fire(t0) {
      const out = { basis: 'none' }; if (keyError) out.keyError = keyError;
      let ordP = null;
      if (this.real) {
        const c = mkt.config, step = +c.step_size, tick = +c.step_price, postOnly = !!mkt.post_only;
        const px = mark * (buy ? 0.985 : 1.015), sizeSteps = Math.max(Math.ceil(+c.min_order_size / step), Math.ceil(11 / mark / step));
        const priceTicks = Math.round(px / tick), tif = postOnly ? 0 : 3;
        if (sizeSteps * step * mark > MAX_NOTIONAL_USD) throw new Error('order size check failed');
        const orderData = packOrder({ marketId, sizeSteps, priceTicks, sell: !buy, postOnly, limit: true, tif });
        out.kind = postOnly ? 'post-only limit order' : 'IOC order';
        ordP = (async () => {
          const permit = await risexPermit(cred, domain, router, placeHash(orderData), anchor, nextBit()); // signing is inside the timed window
          return post('/v1/orders/place', { market_id: Number(marketId), size_steps: sizeSteps, price_ticks: priceTicks, side: buy ? 0 : 1, post_only: postOnly,
            reduce_only: false, stp_mode: 0, order_type: 1, time_in_force: tif, no_retry: true, permit });
        })();
        ordP.catch(() => {});
      }
      const netP = ping(), tn = now(); out.network = (await netP) + (tn - t0);
      if (ordP) {
        try {
          const { t, j, http } = await ordP, d = j.data || {};
          if (d.tx_hash) {
            out.confirmed = t - t0; out.basis = 'real'; out.status = d.message || (out.kind.startsWith('post') ? 'resting' : 'processed');
            out.proof = { kind: 'tx', id: d.tx_hash, url: RISEX_EXPLORER + d.tx_hash, where: 'RISE Chain mainnet' + (d.block_number ? ', block ' + d.block_number : '') };
            out.reply = Object.fromEntries(['order_id', 'tx_hash', 'block_number', 'filled_quantity', 'filled_percent', 'message'].filter(k => d[k] != null && d[k] !== '').map(k => [k, d[k]]));
            if (out.kind.startsWith('post')) resting = d.order_id;
          } else out.error = 'order rejected: ' + (j.message || j.error || 'HTTP ' + http);
          if (out.confirmed != null && out.network >= out.confirmed && baseline != null) { out.network = baseline; out.networkFrom = 'warm-up'; }
        } catch (e) { out.error = e.message; }
      }
      return out;
    },
    async settle() { // cancel a resting post-only probe (untimed)
      if (!resting) return null;
      const open = await getJ(`/v1/orders/open?account=${cred.account}&market_id=${marketId}`);
      const o = (open.orders || []).find(x => x.order_id === resting); if (!o) return { cancel: 'not open any more' };
      const permit = await risexPermit(cred, domain, router, cancelHash(marketId, o.resting_order_id), anchor, nextBit());
      const { j } = await post('/v1/orders/cancel', { market_id: Number(marketId), order_id: resting, permit });
      return { cancel: j.data && j.data.success ? 'cancelled' : 'cancel failed: ' + (j.message || 'unknown') };
    },
    close() {},
  };
}
