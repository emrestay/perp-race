// Local development server: serves the page and runs the same handlers Vercel will run.
// Secrets are read from the macOS Keychain (service "perp-race"); nothing is read from files.
import http from 'node:http';
import { readFile, appendFile, mkdir } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT || 5208);
export const SECRET_NAMES = ['DREAMDEX_KEY', 'HL_AGENT_KEY', 'HL_ENV', 'ARCUS_API_SECRET', 'ARCUS_ADDRESS', 'ARCUS_ACCOUNT_INDEX', 'ARCUS_ENV', 'LIGHTER_API_PRIVATE_KEY', 'LIGHTER_ACCOUNT_INDEX', 'LIGHTER_API_KEY_INDEX', 'ASTER_SIGNER_KEY', 'RISEX_ACCOUNT', 'RISEX_SIGNER_KEY', 'PERPL_API_KEY', 'PERPL_API_KEY_SECRET'];

const found = [];
for (const n of SECRET_NAMES) {
  if (process.env[n]) { found.push(n + ' (env)'); continue; }
  try {
    const v = execFileSync('/usr/bin/security', ['find-generic-password', '-s', 'perp-race', '-a', n, '-w'], { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
    if (v) { process.env[n] = v; found.push(n); }
  } catch {}
}
// First run: make a Somnia testnet burner and keep it in the Keychain so it survives restarts. Never printed.
if (!process.env.DREAMDEX_KEY) {
  try {
    const { generatePrivateKey } = await import('viem/accounts'); const k = generatePrivateKey();
    execFileSync('/usr/bin/security', ['add-generic-password', '-U', '-s', 'perp-race', '-a', 'DREAMDEX_KEY', '-w', k], { stdio: 'ignore' });
    process.env.DREAMDEX_KEY = k; found.push('DREAMDEX_KEY (new testnet burner, stored in Keychain)');
  } catch {}
}
const routes = { '/api/race': (await import('./api/race.js')).GET, '/api/health': (await import('./api/health.js')).GET };
const recent = [];
const STATIC = { '/': 'public/index.html', '/index.html': 'public/index.html' };

http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  try {
    const h = routes[url.pathname];
    if (url.pathname === '/api/recent') {
      let rows = recent;
      if (!rows.length) { try { rows = (await readFile(path.join(ROOT, 'runs', 'races.jsonl'), 'utf8')).trim().split('\n').slice(-30).reverse().map(l => JSON.parse(l)); } catch {} }
      res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' }); res.end(JSON.stringify(rows)); return;
    }
    if (h) {
      const r = await h(new Request(url, { method: 'GET' })), text = await r.text();
      if (url.pathname === '/api/race') { // keep the last races in memory and log one line each (never any secret)
        try {
          const j = JSON.parse(text);
          if (j.venues && !j.cached && !j.shared) {
            recent.unshift(j); recent.length = Math.min(recent.length, 30);
            try { await mkdir(path.join(ROOT, 'runs'), { recursive: true }); await appendFile(path.join(ROOT, 'runs', 'races.jsonl'), JSON.stringify(j) + '\n'); } catch {}
            console.log(new Date(j.at).toISOString().slice(11, 19) + ' ' + j.stock + ' winner=' + j.winner + ' | ' + Object.entries(j.venues).map(([k, v]) => `${k} net=${v.network ?? '-'} conf=${v.confirmed ?? '-'} ${v.basis}${v.status ? ' [' + String(v.status).slice(0, 50) + ']' : ''}${v.maker ? ' maker=' + (v.maker.ms ?? '-') + ' [' + String(v.maker.status || v.maker.error || '').slice(0, 30) + ']' : ''}${v.error ? ' ERR ' + String(v.error).slice(0, 60) : ''}`).join(' | '));
          }
        } catch {}
      }
      res.writeHead(r.status, Object.fromEntries(r.headers)); res.end(text); return;
    }
    const art = url.pathname.match(/^\/derby\/([a-z-]+\.webp)$/); // the race art
    if (art) { res.writeHead(200, { 'content-type': 'image/webp', 'cache-control': 'max-age=3600' }); res.end(await readFile(path.join(ROOT, 'public', 'derby', art[1]))); return; }
    const f = STATIC[url.pathname];
    if (!f) { res.writeHead(404); res.end('not found'); return; }
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' }); res.end(await readFile(path.join(ROOT, f)));
  } catch (e) { res.writeHead(500, { 'content-type': 'application/json' }); res.end(JSON.stringify({ error: e.message })); }
}).listen(PORT, '127.0.0.1', () => {
  console.log(`perp-race dev server on http://localhost:${PORT}`);
  console.log('credentials loaded: ' + (found.length ? found.join(', ') : 'none'));
});
