#!/usr/bin/env node
// Keeps credentials in the macOS Keychain (service "perp-race"). Values are never printed.
//   node scripts/secrets.mjs list            which names are stored
//   node scripts/secrets.mjs set NAME        prompts for the value (hidden) and stores it
//   node scripts/secrets.mjs new-burner      makes a Somnia testnet burner key, stores it, prints its address
//   node scripts/secrets.mjs delete NAME
import { execFileSync, spawnSync } from 'node:child_process';
const NAMES = ['DREAMDEX_KEY', 'HL_AGENT_KEY', 'HL_ENV', 'ARCUS_API_SECRET', 'ARCUS_ADDRESS', 'ARCUS_ACCOUNT_INDEX', 'ARCUS_ENV', 'LIGHTER_API_PRIVATE_KEY', 'LIGHTER_ACCOUNT_INDEX', 'LIGHTER_API_KEY_INDEX', 'ASTER_SIGNER_KEY', 'RISEX_ACCOUNT', 'RISEX_SIGNER_KEY', 'PERPL_API_KEY', 'PERPL_API_KEY_SECRET'];
const SEC = '/usr/bin/security', [cmd, name] = process.argv.slice(2);
const has = n => { try { execFileSync(SEC, ['find-generic-password', '-s', 'perp-race', '-a', n], { stdio: 'ignore' }); return true; } catch { return false; } };
const need = () => { if (!NAMES.includes(name)) { console.error('NAME must be one of: ' + NAMES.join(', ')); process.exit(1); } };

if (cmd === 'list') for (const n of NAMES) console.log((has(n) ? 'set    ' : 'missing') + '  ' + n);
else if (cmd === 'set') { need(); const r = spawnSync(SEC, ['add-generic-password', '-U', '-s', 'perp-race', '-a', name, '-w'], { stdio: 'inherit' }); process.exit(r.status ?? 1); }
else if (cmd === 'delete') { need(); spawnSync(SEC, ['delete-generic-password', '-s', 'perp-race', '-a', name], { stdio: 'ignore' }); console.log('deleted ' + name); }
else if (cmd === 'new-burner') {
  if (has('DREAMDEX_KEY')) { console.error('DREAMDEX_KEY already exists. Delete it first if you really want a new one.'); process.exit(1); }
  const { generatePrivateKey, privateKeyToAccount } = await import('viem/accounts');
  const k = generatePrivateKey();
  execFileSync(SEC, ['add-generic-password', '-U', '-s', 'perp-race', '-a', 'DREAMDEX_KEY', '-w', k], { stdio: 'ignore' });
  console.log('Testnet burner stored. Send it Somnia Tokyo testnet STT:\n' + privateKeyToAccount(k).address);
} else console.log('usage: node scripts/secrets.mjs list | set NAME | new-burner | delete NAME');
