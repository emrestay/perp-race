// Offline checks of the signing code, plus one optional online check (--online) against Hyperliquid TESTNET
// with a throwaway key that has no account: the rejection names the address the signature recovers to.
import { privateKeyToAccount, generatePrivateKey } from 'viem/accounts';
import { createPublicKey, verify, generateKeyPairSync } from 'node:crypto';
import { signL1, hlPrice, hlSize } from '../lib/hyperliquid.js';
import { arcusKey, arcusSign, placePayload, cancelPayload } from '../lib/arcus.js';
import { msgpack } from '../lib/util.js';
import { packOrder, placeHash, risexPermit, risexCred } from '../lib/risex.js';
import { perplCred, signInFrame } from '../lib/perpl.js';
import { keccak256, toBytes, recoverTypedDataAddress, getAddress } from 'viem';

let fails = 0; const ok = (name, cond, extra = '') => { console.log((cond ? 'PASS ' : 'FAIL ') + name + (extra ? '  ' + extra : '')); if (!cond) fails++; };
const hex = u => Buffer.from(u).toString('hex');

// RISEx: order packing and permit, checked against developer.rise.trade/reference/integration
{
  const od = packOrder({ marketId: 1, sizeSteps: 200, priceTicks: 550248, sell: false, postOnly: true, limit: true, tif: 0 });
  ok('risex order packing (docs BTC example)', od === ((1n << 70n) | (200n << 38n) | (550248n << 14n) | (34n << 6n) | (1n << 1n)));
  ok('risex VerifyWitness typehash matches the mainnet contract value in the docs', keccak256(toBytes('VerifyWitness(address account,address target,bytes32 hash,uint48 nonceAnchor,uint8 nonceBitmap,uint32 deadline)')) === '0x055e6bcbf2ba5ff1c2ba5dc95b6648a5de6aaab3185251a34e3b88c11e116821');
  const k = generatePrivateKey(), cred = risexCred({ RISEX_SIGNER_KEY: k, RISEX_ACCOUNT: '0x1111111111111111111111111111111111111111' });
  const domain = { name: 'RISEx', version: '1', chainId: 4153, verifyingContract: '0x0D919DAA3f12AE715744Eb648c00066c5DBd66f0' }, router = getAddress('0xaadde0cea454f2bcb26f46ed54c5709b7bb34a7e'), h = placeHash(od);
  const pm = await risexPermit(cred, domain, router, h, 5, 3), raw = Buffer.from(pm.signature, 'base64');
  const rec = await recoverTypedDataAddress({ domain, primaryType: 'VerifyWitness', signature: '0x' + raw.toString('hex'), message: { account: cred.account, target: router, hash: h, nonceAnchor: 5n, nonceBitmap: 3, deadline: pm.deadline },
    types: { VerifyWitness: [{ name: 'account', type: 'address' }, { name: 'target', type: 'address' }, { name: 'hash', type: 'bytes32' }, { name: 'nonceAnchor', type: 'uint48' }, { name: 'nonceBitmap', type: 'uint8' }, { name: 'deadline', type: 'uint32' }] } });
  ok('risex permit: base64, 65 bytes, recovers to the session key', raw.length === 65 && rec === cred.signer.address && pm.nonce_anchor === '5' && pm.nonce_bitmap_index === 3);
}

// Perpl: WebSocket sign-in, checked against docs.perpl.xyz (four fields joined by newlines, Ed25519, base64url)
{
  const { privateKey: pk } = generateKeyPairSync('ed25519'), raw = pk.export({ format: 'der', type: 'pkcs8' }).subarray(-32).toString('hex');
  const { cred } = perplCred({ PERPL_API_KEY: 'tok', PERPL_API_KEY_SECRET: raw }), f = signInFrame(cred, '1751932800000', '9Nq0Yp3kZ2c1aVb7');
  const ok2 = verify(null, Buffer.from(['143', 'trading-ws-signin', '1751932800000', '9Nq0Yp3kZ2c1aVb7'].join('\n')), createPublicKey(cred.key), Buffer.from(f.signature, 'base64url'));
  ok('perpl sign-in frame verifies', f.mt === 29 && f.chain_id === 143 && f.api_key === 'tok' && !/[=+/]/.test(f.signature) && ok2);
  ok('perpl credential check', !!perplCred({ PERPL_API_KEY: 'x', PERPL_API_KEY_SECRET: 'abc' }).credError && perplCred({}).cred === null);
}

// msgpack: hand-checked encodings
ok('msgpack fixmap/str/bool', hex(msgpack({ a: 1, b: true, p: '100' })) === '83a16101a162c3a170a3313030');
ok('msgpack uint32', hex(msgpack(110001)) === 'ce0001adb1');
ok('msgpack uint16 + array', hex(msgpack([300, false, null])) === '93cd012cc2c0');

// Hyperliquid: vector from the official Python SDK test suite (tests/signing_test.py, test_l1_action_signing_order_matches)
const acct = privateKeyToAccount('0x0123456789012345678901234567890123456789012345678901234567890123');
const action = { type: 'order', orders: [{ a: 1, b: true, p: '100', s: '100', r: false, t: { limit: { tif: 'Gtc' } } }], grouping: 'na' };
const sm = await signL1(acct, action, 0, true), st = await signL1(acct, action, 0, false);
console.log('     mainnet sig', sm.r, sm.s, sm.v); console.log('     testnet sig', st.r, st.s, st.v);
ok('hyperliquid L1 signature, mainnet vector', sm.r === '0xd65369825a9df5d80099e513cce430311d7d26ddf477f5b3a33d2806b100d78e' && sm.s === '0x2b54116ff64054968aa237c20ca9ff68000f977c93289157748a3162b6ea940e' && sm.v === 28, '(vector recalled from the SDK tests; the --online check is the authority)');
ok('hyperliquid price/size formatting', hlPrice(397.8478, 3) === '397.85' && hlPrice(1234.567, 0) === '1234.6' && hlSize(0.029, 3) === '0.029' && hlSize(1, 3) === '1');

// Arcus: canonical payload text and an Ed25519 round trip
const pp = placePayload({ ad: '0xabc', ai: 0, ct: 1700000000000000000n, g: 1800000000000000000n, m: 29, p: 39785, q: 200000, s: 1, t: 2 });
ok('arcus place payload', pp === '{"ad":"0xabc","ai":0,"ct":1700000000000000000,"g":1800000000000000000,"m":29,"op":1,"p":39785,"q":200000,"r":0,"s":1,"t":2,"v":1}');
ok('arcus cancel payload', cancelPayload({ ad: '0xabc', ai: 0, ct: 5n, id: 'o1', m: 29 }) === '{"ad":"0xabc","ai":0,"ct":5,"id":"o1","m":29,"op":2,"v":1}');
const kp = generateKeyPairSync('ed25519'), seed = kp.privateKey.export({ type: 'pkcs8', format: 'der' }).subarray(-32).toString('hex');
const ak = arcusKey(seed), sig = arcusSign(ak.key, pp), pubRaw = kp.publicKey.export({ type: 'spki', format: 'der' }).subarray(-32).toString('hex');
ok('arcus key derivation', ak.apiKey === pubRaw && ak.apiKey.length === 64);
ok('arcus ed25519 signature', sig.length === 128 && verify(null, Buffer.from(pp), createPublicKey(ak.key), Buffer.from(sig, 'hex')));

// Aster V3: the signed text is the url-encoded parameters with nonce and signer appended; the signature must recover to the signer
{
  const { asterSign } = await import('../lib/aster.js'); const { recoverTypedDataAddress } = await import('viem');
  const a = privateKeyToAccount(generatePrivateKey());
  const { msg, sig } = await asterSign(a, { symbol: 'TSLAUSDT', side: 'SELL', type: 'LIMIT', timeInForce: 'IOC', quantity: '0.02', price: '389.10', newOrderRespType: 'RESULT' });
  ok('aster message text', /^symbol=TSLAUSDT&side=SELL&type=LIMIT&timeInForce=IOC&quantity=0\.02&price=389\.10&newOrderRespType=RESULT&nonce=\d{16}&signer=0x[0-9a-fA-F]{40}$/.test(msg), msg.slice(0, 60) + '...');
  const rec = await recoverTypedDataAddress({ domain: { name: 'AsterSignTransaction', version: '1', chainId: 1666, verifyingContract: '0x0000000000000000000000000000000000000000' }, types: { Message: [{ name: 'msg', type: 'string' }] }, primaryType: 'Message', message: { msg }, signature: sig });
  ok('aster signature recovers to the signer', rec === a.address);
}
// Lighter: the WASM signer loads, accepts a key and signs an order (throwaway key, nothing sent)
{
  const { loadSigner, lighterCred } = await import('../lib/lighter.js'); const L = await loadSigner();
  const k = L.GenerateAPIKey(), c = L.CreateClient('', k.privateKey, 304, 4, 12345);
  const o = L.SignCreateOrder(112, 777, 285, 39420, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 4, 12345);
  ok('lighter signer loads and signs', !c.error && !o.error && o.txType === 14 && JSON.parse(o.txInfo).MarketIndex === 112, 'txType ' + o.txType);
  ok('lighter credential check', lighterCred({ LIGHTER_API_PRIVATE_KEY: k.privateKey, LIGHTER_ACCOUNT_INDEX: '12345', LIGHTER_API_KEY_INDEX: '4' }).cred.ai === 12345 && !!lighterCred({ LIGHTER_API_PRIVATE_KEY: 'abc', LIGHTER_ACCOUNT_INDEX: '1', LIGHTER_API_KEY_INDEX: '4' }).credError);
}

if (process.argv.includes('--online')) {
  const a = privateKeyToAccount(generatePrivateKey()), nonce = Date.now();
  const act = { type: 'order', orders: [{ a: 0, b: false, p: '1000000', s: '0.001', r: false, t: { limit: { tif: 'Alo' } } }], grouping: 'na' };
  const signature = await signL1(a, act, nonce, false);
  const r = await fetch('https://api.hyperliquid-testnet.xyz/exchange', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action: act, nonce, signature, vaultAddress: null }) });
  const text = await r.text();
  console.log('     testnet reply:', r.status, text.slice(0, 200));
  ok('hyperliquid signature recovers to our key (testnet rejection names our address)', text.toLowerCase().includes(a.address.toLowerCase()));
}
console.log(fails ? `\n${fails} check(s) failed` : '\nall checks passed'); process.exit(fails ? 1 : 0);
