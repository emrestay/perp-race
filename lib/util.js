// Small shared helpers: timing, a promise-based WebSocket client, a minimal msgpack encoder.
export const now = () => performance.now();
export const sleep = ms => new Promise(r => setTimeout(r, ms));
export const med = a => { const s = a.filter(x => x != null).sort((x, y) => x - y); if (!s.length) return null; const m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
// Accepts a private key with or without the 0x prefix; returns null when it is not 32 bytes of hex.
export const normKey = k => { const h = String(k || '').trim().replace(/^0x/i, ''); return /^[0-9a-fA-F]{64}$/.test(h) ? '0x' + h : null; };
export const round1 = x => x == null ? null : Math.round(x * 10) / 10;

export function withTimeout(p, ms, label) {
  let to; const t = new Promise((_, rej) => { to = setTimeout(() => rej(new Error((label || 'operation') + ' timed out')), ms); });
  return Promise.race([p, t]).finally(() => clearTimeout(to));
}

// WebSocket client. Every listener gets (parsedMessage, arrivalTime); the arrival time is taken
// before parsing so slow JSON work never inflates a measurement.
export class Sock {
  constructor(url) { this.url = url; this.ls = new Set(); this.ws = null; }
  open(timeout = 6000) {
    return withTimeout(new Promise((res, rej) => {
      const ws = this.ws = new WebSocket(this.url);
      ws.onopen = () => res(this);
      ws.onerror = () => rej(new Error('websocket error ' + new URL(this.url).host));
      ws.onmessage = e => { const t = now(); let m; try { m = JSON.parse(e.data); } catch { return; } for (const f of [...this.ls]) f(m, t); };
    }), timeout, 'connect ' + new URL(this.url).host);
  }
  send(o) { this.ws.send(JSON.stringify(o)); }
  sendRaw(text) { this.ws.send(text); }
  on(f) { this.ls.add(f); return () => this.ls.delete(f); }
  waitFor(pred, timeout = 8000, label = 'reply') {
    let off;
    return withTimeout(new Promise(res => { off = this.on((m, t) => { if (pred(m)) { off(); res({ msg: m, t }); } }); }), timeout, label).finally(() => off && off());
  }
  close() { try { this.ws && this.ws.close(); } catch {} }
}

// Minimal msgpack encoder, enough for Hyperliquid actions (maps, arrays, strings, bools, non-negative ints, nil).
export function msgpack(v) {
  const out = [], enc = new TextEncoder();
  (function w(x) {
    if (x === null || x === undefined) out.push(0xc0);
    else if (x === false) out.push(0xc2);
    else if (x === true) out.push(0xc3);
    else if (typeof x === 'number') {
      if (!Number.isInteger(x) || x < 0) throw new Error('msgpack: only non-negative integers are supported');
      if (x < 0x80) out.push(x);
      else if (x < 0x100) out.push(0xcc, x);
      else if (x < 0x10000) out.push(0xcd, x >> 8, x & 0xff);
      else if (x < 0x100000000) out.push(0xce, (x >>> 24) & 0xff, (x >>> 16) & 0xff, (x >>> 8) & 0xff, x & 0xff);
      else { out.push(0xcf); const b = BigInt(x); for (let i = 7; i >= 0; i--) out.push(Number((b >> BigInt(8 * i)) & 0xffn)); }
    } else if (typeof x === 'string') {
      const b = enc.encode(x);
      if (b.length < 32) out.push(0xa0 | b.length); else if (b.length < 0x100) out.push(0xd9, b.length); else out.push(0xda, b.length >> 8, b.length & 0xff);
      for (const c of b) out.push(c);
    } else if (Array.isArray(x)) {
      if (x.length < 16) out.push(0x90 | x.length); else out.push(0xdc, x.length >> 8, x.length & 0xff);
      x.forEach(w);
    } else if (typeof x === 'object') {
      const k = Object.keys(x);
      if (k.length < 16) out.push(0x80 | k.length); else out.push(0xde, k.length >> 8, k.length & 0xff);
      for (const key of k) { w(key); w(x[key]); }
    } else throw new Error('msgpack: unsupported value');
  })(v);
  return Uint8Array.from(out);
}
