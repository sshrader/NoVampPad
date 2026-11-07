// Free: builds the site's "Send out fees" payout for a coin and SIMULATES it. Nothing is spent or signed.
// Usage (from this folder):  node 20-sim-claim.mjs <your wallet address> <coin mint>
import { createRequire } from 'node:module';
import { VersionedTransaction } from '@solana/web3.js';
import { connection, RPC_URL, CLUSTER, IS_MAIN } from './lib.mjs';
const require = createRequire(import.meta.url);
const { createLauncher } = require('../launch.js');
const [wallet, mint] = [process.argv[2], process.argv[3]];
if (!wallet || !mint) { console.error('Usage: node 20-sim-claim.mjs <wallet> <mint>'); process.exit(1); }
const launcher = createLauncher({
  cluster: CLUSTER, allowMainnet: IS_MAIN, rpcUrl: RPC_URL, platformWallet: wallet, platformSharePct: 20,
  load: async () => ({ web3: await import('@solana/web3.js') }), maxPerMinute: 100, maxReadsPerMinute: 100, pairTrade: true
});
console.log('fees :', JSON.stringify((await launcher.fees(mint, { ip: 'cli' })).body.pendingSol));
const r = await launcher.distribute({ pool: mint, payer: wallet }, { ip: 'cli' });
if (!r.body.transaction) { console.log('claim answer:', r.status, JSON.stringify(r.body)); process.exit(0); }
const tx = VersionedTransaction.deserialize(Buffer.from(r.body.transaction, 'base64'));
console.log('transaction size:', tx.serialize().length, 'bytes (limit 1232)');
const s = await connection.simulateTransaction(tx, { sigVerify: false, replaceRecentBlockhash: true, commitment: 'confirmed' });
console.log(s.value.err ? 'FAIL ' + JSON.stringify(s.value.err) : 'PASS (' + s.value.unitsConsumed + ' compute units)');
(s.value.logs || []).slice(-25).forEach(l => console.log('   ' + l));
