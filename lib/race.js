// One race: connect to every venue, warm the connections, then fire all probes in the same instant.
import { now, sleep, withTimeout, round1 } from './util.js';
import * as dreamdex from './dreamdex.js';
import * as hyperliquid from './hyperliquid.js';
import * as arcus from './arcus.js';
import * as lighter from './lighter.js';
import * as aster from './aster.js';
import * as risex from './risex.js';

const ORDER = ['dreamdex', 'hyperliquid', 'arcus', 'lighter', 'aster', 'risex'];

export async function runRace({ stock = 'BTC', side = 'short', env = process.env } = {}) { // stock: a key of MARKETS
  const vs = [dreamdex.create(env, stock, side), hyperliquid.create(env, stock, side), arcus.create(env, stock, side), lighter.create(env, stock, side), aster.create(env, stock, side), risex.create(env, stock, side)];
  const out = { at: Date.now(), region: env.VERCEL_REGION || 'local', stock, side, venues: {} };
  try {
    await Promise.all(vs.map(async v => {
      try { await withTimeout(v.connect(), 7000, 'connect'); await withTimeout(v.prepare(), 9000, 'prepare'); v.ready = true; }
      catch (e) { v.fail = e.message; }
    }));
    const ready = vs.filter(v => v.ready);
    for (let i = 0; i < 2; i++) await Promise.all(ready.map(v => v.ping().catch(() => {})));
    // A stalled event loop makes every reply look simultaneous. Watch the loop while the probes are in
    // flight and run the round again (at most twice) if it stalled; cold processes need a round to warm up.
    let order;
    for (let attempt = 1; attempt <= 3; attempt++) {
      order = [...ready].sort(() => Math.random() - 0.5);
      let last = now(), lag = 0; const iv = setInterval(() => { const t = now(); lag = Math.max(lag, t - last - 4); last = t; }, 4);
      const t0 = now();
      const res = await Promise.all(order.map(v => withTimeout(v.fire(t0), 14000, 'fire').catch(e => ({ basis: 'none', error: e.message }))));
      clearInterval(iv);
      order.forEach((v, i) => { out.venues[v.id] = res[i]; });
      out.attempts = attempt; out.loopLagMs = round1(lag);
      if (lag <= 25) break;
      await sleep(400);
    }
    await sleep(250);
    if (env.PERP_RACE_MAKER === '1') await Promise.all(order.filter(v => v.maker && v.real).map(async v => {
      const t1 = now();
      try { out.venues[v.id].maker = await withTimeout(v.maker(t1), 14000, 'maker'); } catch (e) { out.venues[v.id].maker = { error: e.message }; }
    }));
    await Promise.all(order.filter(v => v.settle).map(async v => { // untimed clean-up, e.g. cancelling a resting order
      try { const r = await withTimeout(v.settle(), 12000, 'settle'); if (r) Object.assign(out.venues[v.id], r); } catch (e) { out.venues[v.id].cancel = 'clean-up failed: ' + e.message; }
    }));
    await Promise.all(order.filter(v => v.proof && out.venues[v.id] && !out.venues[v.id].proof).map(async v => {
      try { const p = await withTimeout(v.proof(), 6000, 'proof'); if (p) out.venues[v.id].proof = p; } catch {}
    }));
    for (const v of vs) if (!v.ready) out.venues[v.id] = { basis: 'none', error: v.fail };
  } finally { for (const v of vs) { try { v.close(); } catch {} } }
  for (const r of Object.values(out.venues)) {
    for (const k of ['network', 'floor', 'confirmed', 'ack']) if (r[k] != null) r[k] = round1(r[k]);
    if (r.maker) for (const k of ['ms', 'ack']) if (r.maker[k] != null) r.maker[k] = round1(r.maker[k]);
  }
  const ranked = ORDER.filter(k => out.venues[k] && out.venues[k].confirmed != null).sort((a, b) => out.venues[a].confirmed - out.venues[b].confirmed);
  out.winner = ranked[0] || null;
  return out;
}
