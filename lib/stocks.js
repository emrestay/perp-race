// One stock perp per row. Listed on the first five venues (verified live on 2026-11-14); RISEx market ids
// verified live on 2026-11-17 (null = not listed on RISEx).
export const STOCKS = {
  TSLA: { pool: '0xe3458a654ce3d839b96581fb46b40a0c37d4cd61', hl: 'xyz:TSLA', arcus: 'TSLA-USD', aster: 'tslausdt', lighter: 112, risex: 32 },
  COIN: { pool: '0xd4fdb2cf877507d401b6c2632bdcb79ebf1ceaf7', hl: 'xyz:COIN', arcus: 'COIN-USD', aster: 'coinusdt', lighter: 109, risex: null },
  MSTR: { pool: '0xaf690c35d4254d63143d5f35b415b8228c4873b6', hl: 'xyz:MSTR', arcus: 'MSTR-USD', aster: 'mstrusdt', lighter: 122, risex: 29 },
  GOOGL: { pool: '0xaa7f246114de23d0e261f01ffe74c6b632e277ae', hl: 'xyz:GOOGL', arcus: 'GOOGL-USD', aster: 'googlusdt', lighter: 116, risex: 42 },
  AMD: { pool: '0x3b844ef76971c6f2274d97eb45b1e2cd3cea2708', hl: 'xyz:AMD', arcus: 'AMD-USD', aster: 'amdusdt', lighter: 138, risex: 55 },
  HOOD: { pool: '0x26d79cd2753e1695bb41dff33c2dd69049a44ee3', hl: 'xyz:HOOD', arcus: 'HOOD-USD', aster: 'hoodusdt', lighter: 108, risex: 34 },
  INTC: { pool: '0xc8442ac3e855c4b693373bcafb5b214ef81c3519', hl: 'xyz:INTC', arcus: 'INTC-USD', aster: 'intcusdt', lighter: 137, risex: 28 },
  MRVL: { pool: '0x2140de5c86333b62dae08b74adb32aa0c7c5195a', hl: 'xyz:MRVL', arcus: 'MRVL-USD', aster: 'mrvlusdt', lighter: 174, risex: null },
};
