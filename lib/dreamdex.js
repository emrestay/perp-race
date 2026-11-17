// DreamDEX on Somnia Tokyo testnet. The probe is a real perp order on the pool of the chosen stock:
// a limit order priced 3% away from mark, so it cannot trade. It is sent with eth_sendRawTransactionSync
// to the validator-facing send endpoint and the clock stops at the receipt. The order then rests on the
// book and is cancelled right after (untimed). An immediate-or-cancel order with nothing to match reverts
// on chain (ImmediateOrCancelNoFill), so a resting limit order is the clean equivalent: it takes the same
// path through the pool and does strictly more work.
// Without margin, or if the market refuses the order, the probe falls back to a zero-value transaction.
import { privateKeyToAccount, generatePrivateKey } from 'viem/accounts';
import { encodeFunctionData, decodeFunctionResult, parseAbi, toEventSelector, maxUint256 } from 'viem';
import { Sock, now, normKey } from './util.js';
import { STOCKS } from './stocks.js';

const API = 'wss://api.hideki.infra.testnet.somnia.network/ws';
const SEND = 'wss://send.hideki.infra.testnet.somnia.network/ws';
const EXPLORER = 'https://explorer.testnet.somnia.network/tokyo/tx/';
const CHAIN_ID = 50383;
const MARGIN_BANK = '0x478769E1177C0773c43A593DCCc4Ad15F15F1394'; // Tokyo testnet, from the Somnia CLI manifest
const USDSO = '0xed7993A74dAe1e6656B704A424DcD8711aAf4F72';
const E18 = 10n ** 18n, MIN_BANK = 20n * E18, DEPOSIT = 50n * E18;
// Gas limits. Storage is expensive on Somnia (a plain approve estimates at about 1.4M gas), so these are
// generous ceilings: only the gas actually used is charged.
const GAS = { approve: 4000000n, deposit: 8000000n, order: 10000000n, cancel: 6000000n, transfer: 30000n };

const POOL = parseAbi([
  'function placeOrder(bool isBid, uint64 userData, uint256 price, uint256 quantity, uint64 expireTimestampNs, uint8 orderType, uint8 selfMatchingOption, address builder, uint96 builderFeeBpsTimes1k)',
  'function cancelOrder(uint128 orderId)',
  'function getOrderBookParameters() view returns ((uint256 tickSize, uint256 minQuantity, uint256 lotSize))',
  'function tryGetMarkPrice() view returns (bool ok, uint256 price)',
]);
const BANK = parseAbi([
  'function deposit(uint256 amount)',
  'function getAccountState(address account) view returns ((int256 unlockedCollateralBalance, uint256 lockedCollateral, address[] activePerpPools))',
]);
const ERC20 = parseAbi([
  'function approve(address spender, uint256 amount) returns (bool)',
  'function allowance(address owner, address spender) view returns (uint256)',
  'function balanceOf(address account) view returns (uint256)',
]);
const PLACED = toEventSelector('OrderPlaced(uint128,(uint128,bool,address,uint64,uint256,uint256,uint256,uint64))');
const ORDER_TYPE_LIMIT = 0, ZERO = '0x0000000000000000000000000000000000000000';
let ephemeralKey = null; // local development only: lives in memory, gone on restart

export function burner(env) {
  const k = normKey(env.DREAMDEX_KEY);
  if (k) return { acct: privateKeyToAccount(k), ephemeral: false };
  if (env.VERCEL) return { acct: null, ephemeral: false }; // serverless instances do not share memory
  ephemeralKey ??= generatePrivateKey();
  return { acct: privateKeyToAccount(ephemeralKey), ephemeral: true };
}

export function create(env, stock = 'TSLA', side = 'short') {
  const { acct } = burner(env), pool = STOCKS[stock].pool, buy = side === 'long';
  let id = 100, api, send, nonce = 0, gasPrice = 6000000000n, orderData = null, restingId = null;
  const rpc = async (sock, method, params = [], timeout = 8000) => {
    const i = ++id, p = sock.waitFor(m => m.id === i, timeout, method);
    sock.send({ jsonrpc: '2.0', id: i, method, params });
    const { msg, t } = await p;
    if (msg.error) throw new Error(msg.error.message || 'rpc error');
    return { result: msg.result, t };
  };
  const read = async (to, abi, functionName, args = []) => {
    const r = await rpc(api, 'eth_call', [{ from: acct.address, to, data: encodeFunctionData({ abi, functionName, args }) }, 'latest']);
    return decodeFunctionResult({ abi, functionName, data: r.result });
  };
  const tx = (to, data, gas, n) => ({ chainId: CHAIN_ID, type: 'eip1559', nonce: n, to, data, value: 0n, gas, maxFeePerGas: gasPrice * 2n, maxPriorityFeePerGas: 0n });
  const sendSync = async (to, data, gas) => rpc(send, 'eth_sendRawTransactionSync', [await acct.signTransaction(tx(to, data, gas, nonce++))], 15000);
  const must = async (label, to, data, gas) => { const r = await sendSync(to, data, gas); if (r.result.status !== '0x1') throw new Error(label + ' reverted'); return r; };
  return {
    id: 'dreamdex', real: false, order: false,
    async connect() {
      api = new Sock(API); send = new Sock(SEND);
      await Promise.all([api.open(), send.open()]);
      api.send({ jsonrpc: '2.0', id: 1, method: 'eth_subscribe', params: ['newHeads'] });
    },
    async prepare() {
      if (acct) {
        const [b, n, g] = await Promise.all([rpc(api, 'eth_getBalance', [acct.address, 'latest']), rpc(api, 'eth_getTransactionCount', [acct.address, 'pending']), rpc(api, 'eth_gasPrice')]);
        nonce = Number(BigInt(n.result)); gasPrice = BigInt(g.result);
        this.real = BigInt(b.result) > GAS.order * gasPrice * 2n * 2n; // the node checks balance against the gas limit
        if (this.real) {
          try {
            // One-time setup: keep some USDso margin in the bank. Skipped once the bank holds enough.
            let state = await read(MARGIN_BANK, BANK, 'getAccountState', [acct.address]);
            if (state.unlockedCollateralBalance < MIN_BANK) {
              const [wallet, allowance] = await Promise.all([read(USDSO, ERC20, 'balanceOf', [acct.address]), read(USDSO, ERC20, 'allowance', [acct.address, MARGIN_BANK])]);
              if (wallet < DEPOSIT) throw new Error('not enough testnet USDso in the wallet for margin');
              if (allowance < DEPOSIT) await must('approve', USDSO, encodeFunctionData({ abi: ERC20, functionName: 'approve', args: [MARGIN_BANK, maxUint256] }), GAS.approve);
              await must('margin deposit', MARGIN_BANK, encodeFunctionData({ abi: BANK, functionName: 'deposit', args: [DEPOSIT] }), GAS.deposit);
            }
            // The order: limit, 3% away from mark, about 11 USD, aligned to the pool's tick and lot.
            const [params, [ok, mark]] = await Promise.all([read(pool, POOL, 'getOrderBookParameters'), read(pool, POOL, 'tryGetMarkPrice')]);
            if (!ok || mark <= 0n) throw new Error('mark price unavailable');
            const price = (mark * (buy ? 97n : 103n) / 100n / params.tickSize) * params.tickSize;
            let qty = ((11n * E18 * E18 / mark) / params.lotSize + 1n) * params.lotSize; if (qty < params.minQuantity) qty = params.minQuantity;
            const expire = BigInt(Date.now() + 3600000) * 1000000n;
            orderData = encodeFunctionData({ abi: POOL, functionName: 'placeOrder', args: [buy, 0n, price, qty, expire, ORDER_TYPE_LIMIT, 0, ZERO, 0n] });
            await rpc(api, 'eth_call', [{ from: acct.address, to: pool, data: orderData }, 'latest']); // dry run: a refusal here means no order is sent
            this.order = true;
          } catch (e) { this.order = false; this.orderError = String(e.message).slice(0, 160); }
        }
        await acct.signTransaction(tx(acct.address, '0x', GAS.transfer, 0)); // warm the signer, never sent
      }
      await rpc(send, 'eth_chainId');
    },
    async ping() { const t = now(); return (await rpc(send, 'eth_chainId')).t - t; },
    async fire(t0) {
      const out = { basis: 'none' }; if (this.orderError) out.orderError = this.orderError;
      const netP = rpc(send, 'eth_chainId');
      const realP = !this.real ? null : this.order ? sendSync(pool, orderData, GAS.order) : sendSync(acct.address, '0x', GAS.transfer);
      if (realP) realP.catch(() => {});
      const net = await netP; out.network = net.t - t0;
      const blockP = new Promise(res => {
        const off = api.on((m, t) => { if (m.method === 'eth_subscription' && t >= net.t) { off(); res(t); } });
        setTimeout(() => { off(); res(null); }, 3000);
      });
      if (realP) {
        try {
          const r = await realP, rc = r.result, good = rc.status === '0x1';
          out.tx = rc.transactionHash; out.block = parseInt(rc.blockNumber, 16); out.execMicros = rc.executionTimeMicros ?? null; out.gasUsed = parseInt(rc.gasUsed, 16);
          out.proof = { kind: 'tx', id: out.tx, url: EXPLORER + out.tx, where: 'Somnia Tokyo testnet, block ' + out.block };
          if (!good) out.error = 'transaction reverted on chain';
          else {
            out.confirmed = r.t - t0; out.basis = 'real';
            if (this.order) {
              const log = (rc.logs || []).find(l => l.address.toLowerCase() === pool.toLowerCase() && l.topics[0] === PLACED);
              restingId = log ? BigInt(log.topics[1]) : null;
              out.kind = 'limit order'; out.status = 'resting'; if (restingId != null) out.orderId = restingId.toString();
            } else { out.kind = 'transaction'; out.status = 'confirmed'; }
          }
        } catch (e) { out.error = e.message; }
      }
      const tb = await blockP; if (tb != null) out.floor = tb - t0;
      if (out.confirmed == null && out.floor != null) { out.confirmed = out.floor; out.basis = 'block'; }
      return out;
    },
    // Untimed clean-up: take the resting order off the book again.
    async settle() {
      if (restingId == null) return null;
      const r = await sendSync(pool, encodeFunctionData({ abi: POOL, functionName: 'cancelOrder', args: [restingId] }), GAS.cancel);
      return { cancel: r.result.status === '0x1' ? 'cancelled' : 'cancel reverted', cancelTx: r.result.transactionHash };
    },
    close() { api && api.close(); send && send.close(); },
  };
}
