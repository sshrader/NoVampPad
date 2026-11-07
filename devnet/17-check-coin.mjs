// Free read of a coin as the site sees it: curve numbers, fees waiting, and whether a buy is allowed. Nothing is spent.
// Usage (from this folder):  node 17-check-coin.mjs <your wallet address> <coin mint>
import { createRequire } from 'node:module';
import { RPC_URL, CLUSTER, IS_MAIN } from './lib.mjs';
const require = createRequire(import.meta.url);
const { createLauncher } = require('../launch.js');
const [wallet, mint] = [process.argv[2], process.argv[3]];
if (!wallet || !mint) { console.error('Usage: node 17-check-coin.mjs <wallet> <mint>'); process.exit(1); }
const launcher = createLauncher({
  cluster: CLUSTER, allowMainnet: IS_MAIN, rpcUrl: RPC_URL, platformWallet: wallet, platformSharePct: 20,
  load: async () => ({ web3: await import('@solana/web3.js') }), maxPerMinute: 100, maxReadsPerMinute: 100, priorityMicroLamports: 0, pairTrade: true
});
const ctx = { ip: 'cli' };
console.log('pool  :', JSON.stringify((await launcher.pool(mint, ctx)).body));
console.log('fees  :', JSON.stringify((await launcher.fees(mint, ctx)).body));
console.log('buy   :', JSON.stringify((await launcher.buy({ pool: mint, buyer: wallet, sol: 1000 }, ctx)).body.error || 'allowed'));
console.log('claim :', JSON.stringify((await launcher.distribute({ pool: mint, payer: wallet }, ctx)).body.error || 'ready'));
