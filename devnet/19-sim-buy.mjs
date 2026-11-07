// Free: builds the site's buy for a coin and SIMULATES it, so a failure shows its reason. Nothing is spent or signed.
// Usage (from this folder):  node 19-sim-buy.mjs <your wallet address> <coin mint> <amount in the pair token, e.g. 10000>
import { createRequire } from 'node:module';
import { VersionedTransaction } from '@solana/web3.js';
import { connection, RPC_URL, CLUSTER, IS_MAIN } from './lib.mjs';
const require = createRequire(import.meta.url);
const { createLauncher } = require('../launch.js');
const [wallet, mint, amount] = [process.argv[2], process.argv[3], Number(process.argv[4] || 10000)];
if (!wallet || !mint) { console.error('Usage: node 19-sim-buy.mjs <wallet> <mint> <amount>'); process.exit(1); }
const launcher = createLauncher({
  cluster: CLUSTER, allowMainnet: IS_MAIN, rpcUrl: RPC_URL, platformWallet: wallet, platformSharePct: 20,
  load: async () => ({ web3: await import('@solana/web3.js') }), maxPerMinute: 100, maxReadsPerMinute: 100, pairTrade: true
});
const r = await launcher.buy({ pool: mint, buyer: wallet, sol: amount }, { ip: 'cli' });
if (!r.body.transaction) { console.log('buy answer:', r.status, JSON.stringify(r.body)); process.exit(0); }
const tx = VersionedTransaction.deserialize(Buffer.from(r.body.transaction, 'base64'));
console.log('transaction size:', tx.serialize().length, 'bytes (limit 1232)');
const s = await connection.simulateTransaction(tx, { sigVerify: false, replaceRecentBlockhash: true, commitment: 'confirmed' });
console.log(s.value.err ? 'FAIL ' + JSON.stringify(s.value.err) : 'PASS (' + s.value.unitsConsumed + ' compute units)');
(s.value.logs || []).slice(-25).forEach(l => console.log('   ' + l));
