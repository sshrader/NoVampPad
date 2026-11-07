// Free check: builds the "create a coin paired with another token" transaction and asks the network to simulate it.
// Nothing is signed or sent, and no money moves. Run it on MAINNET (custom pairs only exist there):
//   PowerShell:  $env:CLUSTER="mainnet-beta"; $env:MAINNET_OK="yes"; $env:RPC_URL="<your mainnet RPC>"
//   then:        node 15-sim-paired-create.mjs <wallet address> <pair token address>
// Example pair (Tesla xStock): XsDoVfqeBukxuZHWhdvWHBhgEHjGNst4MLodqsJHzoB
import { createRequire } from 'node:module';
import * as web3 from '@solana/web3.js';
import { connection, CLUSTER } from './lib.mjs';

const require = createRequire(import.meta.url);
const pump = require('../pump.js');
const { PublicKey, Keypair, TransactionMessage, VersionedTransaction, ComputeBudgetProgram } = web3;
const [walletArg, pairArg] = [process.argv[2], process.argv[3]];
let wallet, pair;
try { wallet = new PublicKey(walletArg); pair = new PublicKey(pairArg); } catch (e) { console.error('Usage: node 15-sim-paired-create.mjs <wallet address> <pair token address>'); process.exit(1); }
if (CLUSTER !== 'mainnet-beta') { console.error('Custom pairs only exist on mainnet. Set CLUSTER=mainnet-beta, MAINNET_OK=yes and RPC_URL first.'); process.exit(1); }

const B = pump.createBuilder(web3);
const pairInfo = await connection.getAccountInfo(pair);
if (!pairInfo) { console.error('That pair token was not found on this network.'); process.exit(1); }
const program = pairInfo.owner;
console.log('Pair token program:', program.toBase58() === pump.TOKEN_2022 ? 'Token-2022' : program.toBase58());

const mint = Keypair.generate();
const ixs = [
  ComputeBudgetProgram.setComputeUnitLimit({ units: 400000 }),
  B.createCoin({ mint: mint.publicKey, user: wallet, name: 'Pair Test', symbol: 'PTEST', uri: 'https://example.com/pair-test.json', quote: { mint: pair, program } })
];
const { blockhash } = await connection.getLatestBlockhash();
const msg = new TransactionMessage({ payerKey: wallet, recentBlockhash: blockhash, instructions: ixs }).compileToV0Message();
const tx = new VersionedTransaction(msg);
const sim = await connection.simulateTransaction(tx, { sigVerify: false, replaceRecentBlockhash: true, commitment: 'confirmed' });
console.log(sim.value.err ? 'FAIL ' + JSON.stringify(sim.value.err) : 'PASS (' + sim.value.unitsConsumed + ' compute units)');
(sim.value.logs || []).slice(-25).forEach(l => console.log('   ' + l));
