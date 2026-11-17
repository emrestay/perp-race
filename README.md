# Perp Race

A latency derby for perp DEXs, drawn as a pony race. Pick a stock, go long or short, and one real order leaves for every venue at the same instant. The first venue to confirm the order crosses the line.

Live: https://perp-horse-race.vercel.app
Code: https://github.com/emrestay/perp-race

The code is open so that anyone can check what is measured and run it themselves.

## What a race does

1. One server function (on Vercel, region `hnd1`, Tokyo) opens a connection to every venue and warms it with two pings.
2. It fires all orders in the same instant. Signing happens inside the timed window.
3. The clock for a venue stops when that venue reports the order as processed. An acknowledgement alone never counts.
4. Every order is priced away from the market so that it cannot trade: no position opens and no fee is paid.

| Venue | Network | Order | Clock stops at | Proof |
|---|---|---|---|---|
| DreamDEX | Somnia Tokyo testnet | limit order via `eth_sendRawTransactionSync`, cancelled right after (untimed) | the transaction receipt | tx on the Somnia explorer |
| Hyperliquid | mainnet, HIP-3 `xyz` dex | IOC order over the WebSocket `post` action | Hyperliquid's order response | tx on the Hyperliquid explorer |
| Arcus | mainnet | IOC order over WebSocket `placeOrder` | final order state on the public `orders` stream | order id |
| Lighter | mainnet | IOC order via REST `sendTx` | final order state on the `account_all_orders` stream | tx hash |
| Aster | mainnet | IOC order via REST `/fapi/v3/order` | the REST response with the final status | order id |
| RISEx | RISE Chain mainnet | IOC order via REST `/v1/orders/place`, signed with an EIP-712 permit by a session key (post-only limit, cancelled after, on post-only markets) | the REST response after the order transaction executed | tx on the RISE explorer |

Each round also times one small request on the same open connection (the "network" time), so the network part and the venue part can be told apart.

Known differences, stated on the page as well:

- The DreamDEX leg runs on testnet with a resting limit order. The other venues get mainnet IOC orders.
- RISEx does not list COIN or MRVL; on those stocks it sits the race out. A venue without credentials on the server is left out of the race.
- The accounts are small, fresh accounts on public APIs. Lighter standard accounts carry a published 300 ms taker delay.
- If the event loop stalls by more than 25 ms during a round, the round is run again (at most three attempts).
- The replay on the page is slowed down and gives the first milliseconds more screen time; each horse reaches the line exactly at its venue's confirmation time and the clock shows real milliseconds.

## Layout

```
api/race.js        GET /api/race?stock=TSLA&side=short  one race (rate limited, cached for 12 s)
api/health.js      GET /api/health                      which venues have credentials, never a secret
lib/race.js        connect, warm, fire, settle, rank
lib/<venue>.js     one adapter per venue (signing, order, final state, proof)
lib/stocks.js      stock to market mapping for every venue
lib/lighter-signer Lighter's official Go signer compiled to WASM (see its README.txt)
public/index.html  the page (vanilla JS, canvas)
dev-server.mjs     local server that runs the same handlers
scripts/           Keychain helper, offline self-test, Vercel env helper
```

## Run it

Node 22 or newer.

```bash
npm install
npm run selftest
npm run dev
```

`npm run dev` serves the page on http://localhost:5208. Credentials are read from environment variables, or on macOS from the Keychain (service `perp-race`):

```bash
node scripts/secrets.mjs list
node scripts/secrets.mjs set HL_AGENT_KEY
```

The names are in `.env.example`. Every venue is optional; without a key a venue only reports network time. On a local or preview deployment, add `?noreal` to the page URL to send only the DreamDEX testnet order (production rejects it).

Never commit keys. Use API or agent keys that cannot withdraw, and keep only a few dollars on each account.

## Deploy

```bash
vercel link
bash scripts/vercel-env.sh preview
vercel deploy
```

## License

MIT, see `LICENSE`.
