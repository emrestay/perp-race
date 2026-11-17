// GET /api/race?stock=TSLA&side=short  → one race, measured from wherever this function runs.
// Real orders sit behind this endpoint, so it is deliberately stingy:
//   - only the known parameters are accepted (anything else is a 400, so the cache cannot be dodged);
//   - successful results are cached at the CDN for a few seconds, so a crowd shares one race;
//   - inside one instance races run one at a time with a minimum gap, and a short queue.
import { runRace } from '../lib/race.js';
import { STOCKS } from '../lib/stocks.js';
import { sleep } from '../lib/util.js';

const MIN_GAP_MS = 10000, CDN_TTL_S = 12, MAX_QUEUE = 2;
const ALLOWED = new Set(['stock', 'side', 'real']);
let chain = Promise.resolve(), lastAt = 0;
const recent = new Map(), pending = new Map();
const json = (body, status = 200, cdn = false) => new Response(JSON.stringify(body), {
  status, headers: { 'content-type': 'application/json', 'cache-control': cdn ? 'public, max-age=0, must-revalidate' : 'no-store', ...(cdn ? { 'vercel-cdn-cache-control': `max-age=${CDN_TTL_S}` } : {}) },
});

function schedule(key, opts) {
  if (pending.has(key)) return pending.get(key);
  if (pending.size >= MAX_QUEUE) return null;
  const p = chain.then(async () => {
    const c = recent.get(key);
    if (c && Date.now() - c.at < MIN_GAP_MS) return { ...c.result, cached: true };
    const wait = MIN_GAP_MS - (Date.now() - lastAt); if (wait > 0) await sleep(wait);
    const r = await runRace(opts); lastAt = Date.now(); recent.set(key, { at: lastAt, result: r });
    return r;
  }).finally(() => pending.delete(key));
  chain = p.catch(() => {}); pending.set(key, p);
  return p;
}

export async function GET(request) {
  const u = new URL(request.url);
  for (const k of u.searchParams.keys()) if (!ALLOWED.has(k)) return json({ error: 'unknown parameter' }, 400);
  const stock = (u.searchParams.get('stock') || 'TSLA').toUpperCase(), sideRaw = u.searchParams.get('side') || 'short', real = u.searchParams.get('real');
  if (!STOCKS[stock] || (sideRaw !== 'long' && sideRaw !== 'short') || (real !== null && real !== '0')) return json({ error: 'bad parameter' }, 400);
  if (real !== null && process.env.VERCEL_ENV === 'production') return json({ error: 'bad parameter' }, 400); // the test mode is not offered publicly
  const dry = real === '0';
  // real=0: never touch a mainnet account. Venues with keys fall back to their network-only lane.
  const env = dry ? { ...process.env, HL_AGENT_KEY: '', ARCUS_API_SECRET: '', ARCUS_ADDRESS: '', LIGHTER_API_PRIVATE_KEY: '', LIGHTER_ACCOUNT_INDEX: '', LIGHTER_API_KEY_INDEX: '', ASTER_SIGNER_KEY: '' } : process.env;
  const p = schedule(`${stock}|${sideRaw}|${dry ? 'dry' : 'real'}`, { stock, side: sideRaw, env });
  if (!p) return json({ error: 'busy', message: 'Another race is running. Try again in a few seconds.' }, 429);
  try {
    const r = await p, out = { ...r, venues: Object.fromEntries(Object.entries(r.venues).map(([k, v]) => { const { frame, ...rest } = v; return [k, rest]; })) }; // raw venue frames stay in the server log only
    if (dry) out.dry = true;
    if (!r.cached) // one line per race in the function log (timings, statuses and public ids only, never a secret)
      console.log('race ' + JSON.stringify({ at: r.at, region: r.region, stock: r.stock, side: r.side, dry, winner: r.winner, attempts: r.attempts, lag: r.loopLagMs,
        venues: Object.fromEntries(Object.entries(r.venues).map(([k, v]) => [k, { network: v.network, ack: v.ack, confirmed: v.confirmed, basis: v.basis, kind: v.kind, status: v.status, maker: v.maker, error: v.error, proof: v.proof && v.proof.id, cancel: v.cancel, frame: v.frame && String(v.frame).slice(0, 200) }])) }));
    return json(out, 200, !dry);
  } catch (e) { return json({ error: e.message }, 500); }
}
