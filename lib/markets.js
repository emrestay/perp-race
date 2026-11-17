// The race runs on crypto perps that DreamDEX lists on Somnia Tokyo mainnet and that every other venue
// lists too (checked live on 2026-11-17 against each venue's market API).
// dd: DreamDEX perp pool on Somnia Tokyo mainnet (chain 50321), bd: its base token decimals.
// hl: Hyperliquid coin (main dex), arcus: market name, aster: symbol, lighter / risex / perpl: market ids
// (null = not listed there; Perpl ids checked live on 2026-11-17).
export const MARKETS = {
  BTC: { dd: '0x143ebd385cc90bd178086a8f432c9084f889ef30', bd: 8, hl: 'BTC', arcus: 'BTC-USD', aster: 'btcusdt', lighter: 1, risex: 1, perpl: 1 },
  ETH: { dd: '0x440992f9910d635201209deb679f8f0c57a6a758', bd: 18, hl: 'ETH', arcus: 'ETH-USD', aster: 'ethusdt', lighter: 0, risex: 2, perpl: 20 },
  SOL: { dd: '0x8508a90867806d2118277372d704b97efde055b3', bd: 9, hl: 'SOL', arcus: 'SOL-USD', aster: 'solusdt', lighter: 2, risex: 4, perpl: 31 },
  HYPE: { dd: '0x81151ad4cdf422fd660a04accb6693c0486e6ccf', bd: 6, hl: 'HYPE', arcus: 'HYPE-USD', aster: 'hypeusdt', lighter: 24, risex: 5, perpl: 40 },
  XRP: { dd: '0x4ac6ac5824cf9de6dfa67d37b431c5d8016360a7', bd: 6, hl: 'XRP', arcus: 'XRP-USD', aster: 'xrpusdt', lighter: 7, risex: 6, perpl: null },
  DOGE: { dd: '0x6441273abb267b06e88a62b06e3b2995aade65ee', bd: 8, hl: 'DOGE', arcus: 'DOGE-USD', aster: 'dogeusdt', lighter: 3, risex: 14, perpl: null },
  BNB: { dd: '0x86818cc4e82013eab08c9dac6573ddf27a8cab6b', bd: 18, hl: 'BNB', arcus: 'BNB-USD', aster: 'bnbusdt', lighter: 25, risex: 3, perpl: null },
  ZEC: { dd: '0xfc0f39f888d6d4f56848786cb494ca8c74213b94', bd: 8, hl: 'ZEC', arcus: 'ZEC-USD', aster: 'zecusdt', lighter: 90, risex: 8, perpl: 50 },
};
// Every probe order is sized near the venue minimum (most are 6 to 19 USD; Aster BTC has a 0.001 BTC
// minimum, about 65 USD). A computed size worth more than this is refused,
// so a units mistake can never send a large order.
export const MAX_NOTIONAL_USD = 80;
