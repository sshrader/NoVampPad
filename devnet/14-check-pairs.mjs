// Read-only: lists the pairing tokens pump.fun allows for new coins on this network (the "custom pair" list). Spends nothing.
// Usage (from this folder):  node 14-check-pairs.mjs            (devnet)
//   mainnet:  CLUSTER=mainnet-beta MAINNET_OK=yes RPC_URL=<your mainnet RPC> node 14-check-pairs.mjs
import { createRequire } from 'node:module';
import * as web3 from '@solana/web3.js';
import { connection, CLUSTER } from './lib.mjs';

const require = createRequire(import.meta.url);
const pump = require('../pump.js');
const { PublicKey } = web3;
const B = pump.createBuilder(web3);

console.log('Network:', CLUSTER);
const g = await connection.getAccountInfo(B.globalPda());
if (!g) { console.log('pump.fun global account not found on this network.'); process.exit(0); }
const [qc] = PublicKey.findProgramAddressSync([Buffer.from('quote-control')], new PublicKey(pump.PUMP));
const q = await connection.getAccountInfo(qc);
if (!q) { console.log('No quote-control account on this network (no custom pairs set up).'); process.exit(0); }

// The list is read by hand: 8 byte tag, admin, reserves admin, 32 reserved bytes, a u32 count, then 40 bytes per pair (mint + starting reserve).
const d = Buffer.from(q.data);
const count = d.readUInt32LE(8 + 32 + 32 + 32);
const start = 8 + 32 + 32 + 32 + 4;
const mints = [];
for (let i = 0; i < count && start + (i + 1) * 40 <= d.length; i++) {
  const at = start + i * 40;
  mints.push({ mint: new PublicKey(d.subarray(at, at + 32)).toBase58(), reserve: d.readBigUInt64LE(at + 32).toString() });
}
console.log('Custom pairs (quote-control):', mints.length, '(account says ' + count + ')');

// Names and symbols, when the RPC supports the "DAS" lookup (Helius does). Otherwise only addresses show.
let meta = {};
try {
  const res = await fetch(process.env.RPC_URL, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'getAssetBatch', params: { ids: mints.map(m => m.mint) } }) });
  const j = await res.json();
  (j.result || []).forEach(a => { if (a && a.id) meta[a.id] = ((a.content && a.content.metadata && a.content.metadata.symbol) || '?') + ' - ' + ((a.content && a.content.metadata && a.content.metadata.name) || '?'); });
} catch (e) { console.log('(names not available from this RPC)'); }
for (const m of mints) console.log('  ' + m.mint + '  ' + (meta[m.mint] || ''));

const gl = Buffer.from(g.data);
const usdc = gl.indexOf(new PublicKey('EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v').toBuffer());
console.log('\nUSDC is built in at byte ' + usdc + ' of the main account.');
