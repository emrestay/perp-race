// GET /api/health → which venues have real-order credentials. Never returns a secret.
import { burner } from '../lib/dreamdex.js';
import { agentOf } from '../lib/hyperliquid.js';
import { arcusCred } from '../lib/arcus.js';
import { lighterCred, loadSigner } from '../lib/lighter.js';
import { asterSigner, asterBalance } from '../lib/aster.js';
import { risexCred } from '../lib/risex.js';

// ?deep=1: ask RISEx whether the session key is registered and active for the account (a read, never an order).
async function risexDeep(c) {
  try {
    const j = await (await fetch(`https://api.rise.trade/v1/auth/session-key-status?account=${c.account}&signer=${c.signer.address}`, { cache: 'no-store' })).json();
    const d = j.data || {}; return { ok: d.status === 1, status: d.status ?? null, description: d.status_description ?? j.message ?? null };
  } catch (e) { return { ok: false, error: e.message }; }
}

// ?deep=1: ask Lighter whether the stored API key is registered for the account (a signed read, never an order).
async function lighterDeep(cred) {
  try {
    const L = await loadSigner(), c = L.CreateClient('', cred.key, 304, cred.ki, cred.ai); if (c && c.error) return { ok: false, error: c.error };
    const a = L.CreateAuthToken(0, cred.ki, cred.ai); if (a.error) return { ok: false, error: a.error };
    const host = 'https://mainnet.zklighter.elliot.ai';
    const lim = await (await fetch(`${host}/api/v1/accountLimits?account_index=${cred.ai}`, { headers: { Authorization: a.authToken } })).json();
    const acc = await (await fetch(`${host}/api/v1/account?by=index&value=${cred.ai}`)).json();
    const x = (acc.accounts || [])[0] || {};
    return { ok: lim.code === 200, code: lim.code, message: lim.message || null, tier: lim.user_tier || null, collateral: x.collateral ?? null, availableBalance: x.available_balance ?? null, l1Address: x.l1_address ?? null, positions: (x.positions || []).filter(p => +p.position !== 0).length };
  } catch (e) { return { ok: false, error: e.message }; }
}

export async function GET(request) {
  const env = process.env, b = burner(env), agent = agentOf(env), ar = arcusCred(env), li = lighterCred(env), as = asterSigner(env), rx = risexCred(env);
  const body = {
    ok: true, region: env.VERCEL_REGION || 'local',
    venues: {
      dreamdex: { network: 'Somnia Tokyo testnet', burner: b.acct ? b.acct.address : null, ephemeral: b.ephemeral },
      hyperliquid: { realOrders: !!agent, keyPresent: !!env.HL_AGENT_KEY, agent: agent ? agent.address : null, network: env.HL_ENV === 'testnet' ? 'testnet' : 'mainnet' },
      arcus: { realOrders: !!ar.cred, apiKey: ar.cred ? ar.cred.apiKey : null, address: ar.cred ? ar.cred.address : null, accountIndex: ar.cred ? ar.cred.ai : null, keyError: ar.credError, network: env.ARCUS_ENV === 'testnet' ? 'testnet' : 'mainnet' },
      lighter: { realOrders: !!li.cred, accountIndex: li.cred ? li.cred.ai : null, apiKeyIndex: li.cred ? li.cred.ki : null, keyError: li.credError, network: 'mainnet' },
      aster: { realOrders: !!as, signer: as ? as.address : null, keyError: env.ASTER_SIGNER_KEY && !as ? 'ASTER_SIGNER_KEY is not a valid private key' : null, network: 'mainnet' },
      risex: { realOrders: !!rx, account: rx ? rx.account : null, signer: rx ? rx.signer.address : null, keyError: (env.RISEX_SIGNER_KEY || env.RISEX_ACCOUNT) && !rx ? 'RISEX_SIGNER_KEY and RISEX_ACCOUNT are both required' : null, network: 'mainnet' },
    },
  };
  // On the public production site this endpoint says only what the page needs: no account identifiers,
  // no balances and no signed checks.
  if (env.VERCEL_ENV === 'production') {
    const pub = { ok: true, region: body.region, venues: { dreamdex: { network: body.venues.dreamdex.network, burner: body.venues.dreamdex.burner } } };
    for (const k of ['hyperliquid', 'arcus', 'lighter', 'aster', 'risex']) pub.venues[k] = { realOrders: body.venues[k].realOrders };
    return new Response(JSON.stringify(pub), { headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } });
  }
  const deep = request && new URL(request.url).searchParams.get('deep') === '1';
  if (deep && li.cred) body.venues.lighter.check = await lighterDeep(li.cred);
  if (deep && as) body.venues.aster.check = await asterBalance(env);
  if (deep && rx) body.venues.risex.check = await risexDeep(rx);
  return new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } });
}
