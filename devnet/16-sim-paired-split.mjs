// Free check: simulates "create a paired coin" AND "set its three-way fee split" in one transaction. Nothing is sent.
// Run on MAINNET like 15-sim-paired-create.mjs:
//   node 16-sim-paired-split.mjs <wallet address> <pair token address>
import { createRequire } from 'node:module';
import * as web3 from '@solana/web3.js';
import { connection, CLUSTER } from './lib.mjs';

const require = createRequire(import.meta.url);
const pump = require('../pump.js');
const { PublicKey, Keypair, TransactionMessage, VersionedTransaction, ComputeBudgetProgram } = web3;
let wallet, pair;
try { wallet = new PublicKey(process.argv[2]); pair = new PublicKey(process.argv[3]); } catch (e) { console.error('Usage: node 16-sim-paired-split.mjs <wallet address> <pair token address>'); process.exit(1); }
if (CLUSTER !== 'mainnet-beta') { console.error('Set CLUSTER=mainnet-beta, MAINNET_OK=yes and RPC_URL first.'); process.exit(1); }

const B = pump.createBuilder(web3);
const info = await connection.getAccountInfo(pair);
if (!info) { console.error('That pair token was not found on this network.'); process.exit(1); }
const quote = { mint: pair, program: info.owner };
const owner = Keypair.generate().publicKey, platform = Keypair.generate().publicKey; // stand-ins: only the split's shape is checked
const mint = Keypair.generate();
const ixs = [
  ComputeBudgetProgram.setComputeUnitLimit({ units: 600000 }),
  B.createCoin({ mint: mint.publicKey, user: wallet, name: 'Pair Test', symbol: 'PTEST', uri: 'https://example.com/pair-test.json', quote }),
  B.createSharingConfig({ mint: mint.publicKey, payer: wallet }),
  B.setShares({ mint: mint.publicKey, authority: wallet, currentShareholders: [wallet], quote,
    shareholders: [{ address: wallet, bps: 7000 }, { address: owner, bps: 2000 }, { address: platform, bps: 1000 }] })
];
const { blockhash } = await connection.getLatestBlockhash();
const tx = new VersionedTransaction(new TransactionMessage({ payerKey: wallet, recentBlockhash: blockhash, instructions: ixs }).compileToV0Message());
const sim = await connection.simulateTransaction(tx, { sigVerify: false, replaceRecentBlockhash: true, commitment: 'confirmed' });
console.log(sim.value.err ? 'FAIL ' + JSON.stringify(sim.value.err) : 'PASS (' + sim.value.unitsConsumed + ' compute units)');
(sim.value.logs || []).slice(-12).forEach(l => console.log('   ' + l.slice(0, 160)));
