# Perp Race

A latency derby for perp DEXs, run as a horse race. Pick a crypto perp, go long or short, and one real order leaves for every venue at the same instant. Every venue runs on mainnet. The first venue to confirm the order crosses the line.

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
| DreamDEX | Somnia Tokyo mainnet | limit order via `eth_sendRawTransactionSync`, cancelled right after (untimed) | the transaction receipt | tx on the Somnia explorer |
| Hyperliquid | mainnet | IOC order over the WebSocket `post` action | Hyperliquid's order response | tx on the Hyperliquid explorer |
| Arcus | mainnet | IOC order over WebSocket `placeOrder` | final order state on the public `orders` stream | the order in Arcus's public order list for the account (`/v1/orders?address=`) |
| Lighter | mainnet | IOC order via REST `sendTx` | final order state on the `account_all_orders` stream | the transaction on Lighter's public API (`/api/v1/tx?by=hash`), kept for a few minutes only |
| Aster | mainnet | IOC order via REST `/fapi/v3/order` | the REST response with the final status | Aster's own reply (no public record of a single order) |
| RISEx | RISE Chain mainnet | IOC order via REST `/v1/orders/place`, signed with an EIP-712 permit by a session key (post-only limit, cancelled after, on post-only markets) | the REST response after the order transaction executed | tx on the RISE explorer |

The results board also shows each venue's own reply for its order (a "reply" button).

Each round also times one small request on the same open connection (the "network" time), so the network part and the venue part can be told apart.

Known differences, stated on the page as well:

- Markets: BTC, ETH, SOL, HYPE, XRP, DOGE, BNB, ZEC, the crypto perps DreamDEX lists on mainnet that every other venue lists too (`lib/markets.js`).
- The DreamDEX leg is a resting limit order (an IOC order with nothing to match reverts on chain); the other venues get IOC orders. All are priced away from the market: 3% (1.5% on Aster and RISEx, inside their price bands).
- Order sizes are near each venue's minimum, mostly 6 to 19 USD; a computed size above 80 USD is refused (`MAX_NOTIONAL_USD`). A venue without credentials on the server is left out of the race.
- The accounts are small, fresh accounts on public APIs. Lighter standard accounts carry a published 300 ms taker delay.
- If the event loop stalls by more than 25 ms during a round, the round is run again (at most three attempts).
- The replay on the page is slowed down and gives the first milliseconds more screen time; each horse reaches the line exactly at its venue's confirmation time and the clock shows real milliseconds.

## Layout

```
api/race.js        GET /api/race?market=BTC&side=short  one race (rate limited, cached for 12 s)
api/health.js      GET /api/health                      which venues have credentials, never a secret
lib/race.js        connect, warm, fire, settle, rank
lib/<venue>.js     one adapter per venue (signing, order, final state, proof)
lib/markets.js     market mapping for every venue, plus the size guard
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

The names are in `.env.example`. Every venue is optional; without a key a venue only reports network time. On a local or preview deployment, add `?noreal` to the page URL to send only the DreamDEX order (production rejects it).

Never commit keys. Use API or agent keys that cannot withdraw, and keep only a few dollars on each account.

## Deploy

```bash
vercel link
bash scripts/vercel-env.sh preview
vercel deploy
```

## License

MIT, see `LICENSE`.

The horse, track and fence art in `public/derby/` comes from [Chain Derby](https://github.com/SmoothBot/chain-derby) by SmoothBot (MIT); see `public/derby/CREDITS.txt`.
