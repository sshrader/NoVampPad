// Read-only: the non-stock pairing tokens, short, with price when the RPC knows it, to pick a cheap one for a test. Spends nothing.
// Usage (mainnet env vars set, from this folder):  node 18-list-test-pairs.mjs
import { createRequire } from 'node:module';
import * as web3 from '@solana/web3.js';
import { connection } from './lib.mjs';
const require = createRequire(import.meta.url);
const pump = require('../pump.js');
const [qc] = web3.PublicKey.findProgramAddressSync([Buffer.from('quote-control')], new web3.PublicKey(pump.PUMP));
const q = await connection.getAccountInfo(qc);
const d = Buffer.from(q.data), start = 8 + 32 + 32 + 32 + 4, count = d.readUInt32LE(start - 4);
const ids = [];
for (let i = 0; i < count && start + (i + 1) * 40 <= d.length; i++) ids.push(new web3.PublicKey(d.subarray(start + i * 40, start + i * 40 + 32)).toBase58());
const res = await fetch(process.env.RPC_URL, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'getAssetBatch', params: { ids } }) });
const rows = ((await res.json()).result || []).filter(a => a && a.id).map(a => {
  const m = (a.content && a.content.metadata) || {}, t = a.token_info || {}, p = t.price_info || {};
  return { id: a.id, sym: m.symbol || '?', name: m.name || '?', prog: t.token_program === 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb' ? 'T22' : 'SPL', price: p.price_per_token };
}).filter(r => !/xstock|securities|etf/i.test(r.name));
rows.sort((a, b) => (b.price ? 1 : 0) - (a.price ? 1 : 0) || String(a.sym).localeCompare(b.sym));
console.log(rows.length + ' non-stock pairs (price in USD where known; prefer SPL, cheap, well known):');
rows.forEach(r => console.log(r.sym.padEnd(10), r.prog, String(r.price !== undefined ? '$' + r.price : '?').padEnd(12), r.name.slice(0, 28), r.id));
