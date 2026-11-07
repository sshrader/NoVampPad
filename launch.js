'use strict';

// Launch flow on the pump.fun protocol, server side. The server builds UNSIGNED transactions for the
// creator's wallet to sign. It holds no keys: the only secret it generates is the new coin's mint keypair,
// which signs once here and is then discarded. A launch is up to three transactions, each built once the
// last one has landed: 1) create the coin, 2) split its creator fees between the creator and HatchPad,
// 3) the creator's optional first buy. Mainnet is refused until MAINNET_ENABLED=yes.
//
// web3.js is loaded only when someone launches, so a problem with it can never stop the website from starting.

const pump = require('./pump.js');

const SYMBOL_RE = /^[A-Za-z0-9]{1,10}$/;
const ART_ID_RE = /^[0-9a-f]{16}$/;
const B58_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const SIG_RE = /^[1-9A-HJ-NP-Za-km-z]{80,90}$/;
const MAX_URI = 200; // the on-chain metadata URI limit
const MIN_BUY_SOL = 0.01;
const MAX_BUY_SOL = 5;

// Strips control, invisible format and separator characters: control, invisible format, and line separator characters.
function cleanText(s, max) {
  if (typeof s !== 'string') return '';
  return s.replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, '').replace(/\s+/g, ' ').trim().slice(0, max);
}

// Small in-memory limiter: each launch preparation makes an RPC call.
function createLimiter(max, windowMs, now) {
  const hits = new Map();
  return function allow(key) {
    const t = now();
    const recent = (hits.get(key) || []).filter(x => t - x < windowMs);
    if (recent.length >= max) { hits.set(key, recent); return false; }
    recent.push(t);
    hits.set(key, recent);
    if (hits.size > 5000) for (const [k, v] of hits) if (!v.some(x => t - x < windowMs)) hits.delete(k);
    return true;
  };
}

async function loadReal() {
  return { web3: await import('@solana/web3.js') };
}

const CU = { create: 400000, split: 250000, buy: 300000, distribute: 300000 };

function createLauncher(opts) {
  const o = opts || {};
  const cluster = o.cluster || 'devnet';
  if (cluster !== 'devnet' && cluster !== 'mainnet-beta') throw new Error('Unknown cluster "' + cluster + '". Use devnet or mainnet-beta.');
  const isMain = cluster === 'mainnet-beta';
  if (isMain && o.allowMainnet !== true) throw new Error('Mainnet is switched off. Set MAINNET_ENABLED=yes to allow real-money launches.');
  const rpcUrl = o.rpcUrl || (isMain ? '' : 'https://api.devnet.solana.com');
  const load = o.load || loadReal;
  const logger = o.logger || console;
  const allow = createLimiter(o.maxPerMinute || 10, 60000, o.now || Date.now);
  const allowRead = createLimiter(o.maxReadsPerMinute || 120, 60000, o.now || Date.now);
  const priorityMicro = Number.isFinite(Number(o.priorityMicroLamports)) ? Math.max(0, Math.floor(Number(o.priorityMicroLamports))) : (isMain ? 50000 : 0);

  if (isMain && !rpcUrl) throw new Error('Mainnet needs LAUNCH_RPC_URL set to a dedicated mainnet RPC.');
  if (isMain && /devnet|testnet/i.test(rpcUrl)) throw new Error('LAUNCH_CLUSTER is mainnet-beta but LAUNCH_RPC_URL looks like devnet.');
  if (!isMain && /mainnet/i.test(rpcUrl)) throw new Error('LAUNCH_CLUSTER is devnet but LAUNCH_RPC_URL looks like mainnet.');

  // The platform's cut of each coin's creator fees, paid to this wallet through pump.fun's fee sharing.
  const platformWallet = typeof o.platformWallet === 'string' && B58_RE.test(o.platformWallet) ? o.platformWallet : '';
  const holderFeeSol = Number.isFinite(Number(o.holderLaunchFeeSol)) && Number(o.holderLaunchFeeSol) >= 0 ? Number(o.holderLaunchFeeSol) : 0.05;
  const platformPct = o.platformSharePct === undefined || o.platformSharePct === '' ? 20 : Number(o.platformSharePct);
  if (!Number.isInteger(platformPct) || platformPct < 1 || platformPct > 50) throw new Error('PLATFORM_SHARE_PCT must be a whole number from 1 to 50.');
  const enabled = Boolean(platformWallet);
  // A shared address lookup table (made once by devnet/12-make-lookup-table.mjs) lets the coin's creation and the
  // creator's first buy fit in ONE transaction, so nobody can buy in between. Without it a launch is up to three steps.
  const lookupTable = typeof o.lookupTable === 'string' && B58_RE.test(o.lookupTable) ? o.lookupTable : '';
  let tableCache = null;

  function info() {
    const out = { enabled, cluster, protocol: 'pump.fun', atomic: Boolean(lookupTable), platformPct, holderLaunchFeeSol: holderFeeSol };
    if (enabled) { out.split = { creatorPct: 100 - platformPct, platformPct }; out.platformWallet = platformWallet; }
    return out;
  }

  async function chain() {
    const { web3 } = await load();
    return { web3, connection: new web3.Connection(rpcUrl, 'confirmed'), B: pump.createBuilder(web3) };
  }

  let globalCache = null;
  async function readGlobal(c) {
    const now = (o.now || Date.now)();
    if (globalCache && now - globalCache.at < 60000) return globalCache.value;
    const acc = await c.connection.getAccountInfo(c.B.globalPda());
    if (!acc) throw new Error('pump.fun global account not found on this network');
    const value = pump.decodeAccount(pump.IDLS.pump, 'Global', acc.data, c.web3);
    globalCache = { at: now, value };
    return value;
  }

  async function readCurve(c, mint) {
    const acc = await c.connection.getAccountInfo(c.B.bondingCurveOf(mint));
    if (!acc || acc.owner.toBase58() !== pump.PUMP) return null;
    return pump.decodeAccount(pump.IDLS.pump, 'BondingCurve', acc.data, c.web3);
  }

  // The token a coin is paired with, when it is not SOL: its mint, which token program owns it, and its decimals.
  async function quoteFromMint(c, mintStr) {
    const pk = new c.web3.PublicKey(mintStr);
    const info = await c.connection.getAccountInfo(pk);
    if (!info || !info.data || info.data.length < 45) return null;
    return { mint: pk, program: info.owner, decimals: info.data[44] };
  }
  async function quoteOfCurve(c, curve) {
    const q = curve && curve.quote_mint ? (curve.quote_mint.toBase58 ? curve.quote_mint.toBase58() : String(curve.quote_mint)) : '';
    if (!q || q === '11111111111111111111111111111111' || q === pump.WSOL) return null;
    return quoteFromMint(c, q);
  }

  function budget(c, units) {
    const cb = c.web3.ComputeBudgetProgram;
    if (!cb) return [];
    const ixs = [cb.setComputeUnitLimit({ units })];
    if (priorityMicro > 0) ixs.push(cb.setComputeUnitPrice({ microLamports: priorityMicro }));
    return ixs;
  }

  // The lookup table, if one is set and safe to use: it must exist and be frozen (nobody can change its addresses).
  async function getTable(c) {
    if (!lookupTable) return null;
    const now = (o.now || Date.now)();
    if (tableCache && now - tableCache.at < 300000) return tableCache.value;
    let value = null;
    try {
      const r = await c.connection.getAddressLookupTable(new c.web3.PublicKey(lookupTable));
      const t = r && r.value;
      if (t && t.state && !t.state.authority) value = t;
      else logger.error('Lookup table ' + lookupTable + ' is missing or not frozen, so launches fall back to separate steps.');
    } catch (err) {
      logger.error('Lookup table could not be read: ' + (err && err.message ? err.message : 'unknown error'));
    }
    tableCache = { at: now, value };
    return value;
  }

  async function toV0(c, ixs, payer, table, signers) {
    const latest = await c.connection.getLatestBlockhash('confirmed');
    const msg = new c.web3.TransactionMessage({ payerKey: payer, recentBlockhash: latest.blockhash, instructions: ixs }).compileToV0Message([table]);
    const vtx = new c.web3.VersionedTransaction(msg);
    if (signers && signers.length) vtx.sign(signers);
    const raw = Buffer.from(vtx.serialize());
    if (raw.length > 1232) throw new Error('transaction too large: ' + raw.length + ' bytes');
    return raw.toString('base64');
  }

  async function toTx(c, ixs, payer, signers, table) {
    if (table) return toV0(c, ixs, payer, table, signers);
    const tx = new c.web3.Transaction();
    ixs.forEach(ix => tx.add(ix));
    const latest = await c.connection.getLatestBlockhash('confirmed');
    tx.feePayer = payer;
    tx.recentBlockhash = latest.blockhash;
    (signers || []).forEach(k => tx.partialSign(k));
    return tx.serialize({ requireAllSignatures: false, verifySignatures: false }).toString('base64');
  }

  // A launchpad built with BuildAPad adds its owner as a third shareholder: { owner, ownerPct }. The launcher always
  // keeps at least half, and a wallet that appears twice (the owner launching on their own pad) is paid once.
  const ownerPctOf = pad => (pad && typeof pad.owner === 'string' && B58_RE.test(pad.owner) && Number.isInteger(pad.ownerPct) && pad.ownerPct > 0 ? Math.min(pad.ownerPct, 50 - platformPct) : 0);
  const splitFor = pad => { const ownerPct = ownerPctOf(pad); return { creatorPct: 100 - platformPct - ownerPct, ownerPct, platformPct }; };
  const shares = (creator, pad) => {
    const sp = splitFor(pad);
    const parts = [[creator, sp.creatorPct], [platformWallet, sp.platformPct]];
    if (sp.ownerPct) parts.push([pad.owner, sp.ownerPct]);
    const merged = [];
    parts.forEach(([address, pct]) => {
      const hit = merged.find(m => m.address === address);
      if (hit) hit.bps += pct * 100; else merged.push({ address, bps: pct * 100 });
    });
    return merged;
  };

  function parseBuy(v) {
    const n = v === undefined || v === null || v === '' ? 0 : Number(v);
    return Number.isFinite(n) && n >= 0 && (n === 0 || (n >= MIN_BUY_SOL && n <= MAX_BUY_SOL)) ? n : null;
  }

  // Step 1: create the coin. Returns { status, body }. Never throws.
  async function prepare(input, ctx) {
    if (!enabled) return { status: 503, body: { error: 'launch_unavailable' } };
    if (!allow((ctx && ctx.ip) || 'unknown')) return { status: 429, body: { error: 'rate_limited' } };

    const b = input && typeof input === 'object' ? input : {};
    const name = cleanText(b.name, 32);
    if (!name) return { status: 400, body: { error: 'bad_name' } };
    const symbol = typeof b.symbol === 'string' ? b.symbol.replace(/^\$/, '').trim().toUpperCase() : '';
    if (!SYMBOL_RE.test(symbol)) return { status: 400, body: { error: 'bad_symbol' } };
    if (typeof b.creator !== 'string' || !B58_RE.test(b.creator)) return { status: 400, body: { error: 'bad_creator' } };

    let artId = '';
    if (b.art !== undefined && b.art !== null && b.art !== '') {
      artId = typeof b.art === 'string' && ART_ID_RE.test(b.art) ? b.art : '';
      if (!artId || !(ctx && typeof ctx.hasArt === 'function' && ctx.hasArt(artId))) return { status: 400, body: { error: 'bad_art' } };
    }
    // The founder picture (the HatchPad logo) can only be launched by the founder wallet, so nobody else can launch a coin that looks like the brand.
    if (artId && ctx && ctx.founder && artId === ctx.founder.id && b.creator !== ctx.founder.wallet) return { status: 403, body: { error: 'founder_only' } };
    const firstBuySol = parseBuy(b.firstBuySol);
    if (firstBuySol === null) return { status: 400, body: { error: 'bad_amount' } };
    const base = String((ctx && ctx.baseUrl) || '').replace(/\/+$/, '');
    const uri = base + '/meta.json?n=' + encodeURIComponent(name) + '&s=' + encodeURIComponent(symbol) + (artId ? '&i=' + artId : '');
    if (!/^https?:\/\//.test(base) || uri.length > MAX_URI) return { status: 400, body: { error: 'uri_too_long' } };

    try {
      const c = await chain();
      const creatorPk = new c.web3.PublicKey(b.creator);
      const mintKp = c.web3.Keypair.generate();
      // A holder rewards pad: the coin is created so that every creator fee goes to its holders, and the launcher pays a flat
      // launch fee to the platform in the same transaction. There is no fee split to set up afterwards.
      const holder = Boolean(ctx && ctx.pad && ctx.pad.holderRewards);
      if (holder && ctx.pad.pair) return { status: 400, body: { error: 'holder_pair_unsupported' } };
      if (holder && firstBuySol > 0) return { status: 400, body: { error: 'holder_buy_not_ready' } };
      // A pad with a pool pair other than SOL creates its coins against that token. The first buy for those is not built yet.
      let quote = null;
      if (ctx && ctx.pad && ctx.pad.pair) {
        if (firstBuySol > 0) return { status: 400, body: { error: 'pair_buy_not_ready' } };
        quote = await quoteFromMint(c, ctx.pad.pair);
        if (!quote) return { status: 409, body: { error: 'pair_not_found' } };
      }
      const ix = c.B.createCoin({ mint: mintKp.publicKey, user: creatorPk, name, symbol, uri, quote, holderReward: holder });
      const mint = mintKp.publicKey.toBase58();
      const table = await getTable(c);
      const atomic = Boolean(table);
      let ixs = budget(c, CU.create).concat([ix]);
      if (holder && holderFeeSol > 0) ixs.push(c.B.transferSol({ from: creatorPk, to: platformWallet, lamports: Math.round(holderFeeSol * 1e9) }));
      if (atomic && firstBuySol > 0) {
        // The coin does not exist yet, so the buy is priced against a fresh curve from pump.fun's global settings.
        const glob = await readGlobal(c);
        const fresh = {
          virtual_token_reserves: glob.initial_virtual_token_reserves, virtual_quote_reserves: glob.initial_virtual_sol_reserves,
          real_token_reserves: glob.initial_real_token_reserves
        };
        ixs = budget(c, CU.create + CU.buy).concat([ix], buyInstructions(c, creatorPk, mint, fresh, firstBuySol, 1000, glob));
      }
      const transaction = await toTx(c, ixs, creatorPk, [mintKp], table);
      return { status: 200, body: { transaction, mint, pool: mint, curve: c.B.bondingCurveOf(mintKp.publicKey).toBase58(), firstBuySol, atomic, pair: quote ? quote.mint.toBase58() : '', holderRewards: holder, launchFeeSol: holder ? holderFeeSol : 0, split: holder ? { creatorPct: 0, ownerPct: 0, platformPct: 0 } : splitFor(ctx && ctx.pad), cluster } };
    } catch (err) {
      logger.error('Launch prepare failed: ' + (err && err.stack ? err.stack : 'unknown error'));
      return { status: 502, body: { error: 'prepare_failed' } };
    }
  }

  // Steps 2 and 3: after the coin exists, say what is left to sign. Reads the chain, so it can be asked again
  // after a closed tab. { step: 'waiting' | 'split' | 'buy' | 'done', transaction? }
  async function step(input, ctx) {
    if (!enabled) return { status: 503, body: { error: 'launch_unavailable' } };
    if (!allowRead((ctx && ctx.ip) || 'unknown')) return { status: 429, body: { error: 'rate_limited' } };
    const b = input && typeof input === 'object' ? input : {};
    if (typeof b.mint !== 'string' || !B58_RE.test(b.mint)) return { status: 400, body: { error: 'bad_mint' } };
    if (typeof b.creator !== 'string' || !B58_RE.test(b.creator)) return { status: 400, body: { error: 'bad_creator' } };
    const firstBuySol = parseBuy(b.firstBuySol);
    if (firstBuySol === null) return { status: 400, body: { error: 'bad_amount' } };
    try {
      const c = await chain();
      const curve = await readCurve(c, b.mint);
      if (!curve) return { status: 200, body: { step: 'waiting' } };
      const creatorPk = new c.web3.PublicKey(b.creator);
      const sharing = c.B.sharingConfigOf(b.mint).toBase58();
      const table = await getTable(c);
      const quote = await quoteOfCurve(c, curve);
      // A holder rewards coin has no fee split to set: its creator fee goes to holders on its own.
      if (curve.is_holder_reward) return { status: 200, body: { step: 'done' } };
      if (curve.creator === b.creator) {
        // Fees that have built up on the curve must be swept before the creator is swapped for the split.
        const ixs = [];
        if (Number(curve.creator_fee || 0n) > 0) ixs.push(c.B.sweepCreatorFee({ payer: creatorPk, mint: b.mint, creator: creatorPk, quote }));
        ixs.push(c.B.createSharingConfig({ mint: b.mint, payer: creatorPk }));
        if (quote) c.B.createFeeVaultAtas({ mint: b.mint, payer: creatorPk, quote }).forEach(x => ixs.push(x));
        ixs.push(c.B.setShares({ mint: b.mint, authority: creatorPk, shareholders: shares(b.creator, ctx && ctx.pad), currentShareholders: [creatorPk], quote }));
        return { status: 200, body: { step: 'split', transaction: await toTx(c, budget(c, CU.split).concat(ixs), creatorPk, null, table), cluster } };
      }
      if (curve.creator !== sharing) return { status: 403, body: { error: 'not_creator' } };
      // Without a lookup table the first buy is its own, last step. With one it was part of the launch transaction.
      if (firstBuySol > 0 && !table && !quote) {
        let held = 0n;
        try {
          const bal = await c.connection.getTokenAccountBalance(c.B.ata(creatorPk, b.mint, pump.TOKEN_2022));
          held = BigInt(bal && bal.value ? bal.value.amount : 0);
        } catch (e) { held = 0n; }
        if (held === 0n && !curve.complete) {
          const t = await buildBuy(c, creatorPk, b.mint, curve, firstBuySol, 1000);
          return { status: 200, body: { step: 'buy', transaction: t, cluster } };
        }
      }
      return { status: 200, body: { step: 'done' } };
    } catch (err) {
      logger.error('Launch step failed: ' + (err && err.stack ? err.stack : 'unknown error'));
      return { status: 502, body: { error: 'prepare_failed' } };
    }
  }

  // The create-ATA and buy instructions for spending `sol`, with a minimum worked out from the curve.
  function buyInstructions(c, buyerPk, mint, curve, sol, slippageBps, glob) {
    const lamports = BigInt(Math.floor(sol * 1e9));
    const min = pump.minTokensForBuy(curve, lamports, slippageBps, pump.feeGuessBps(glob));
    if (min <= 0n) throw new Error('quote came out as zero');
    const recipients = Array.isArray(glob.buyback_fee_recipients) && glob.buyback_fee_recipients.length ? glob.buyback_fee_recipients : pump.BUYBACK_RECIPIENTS;
    return [
      c.B.createAtaIdempotent(buyerPk, buyerPk, mint, pump.TOKEN_2022),
      c.B.buyExactIn({ user: buyerPk, mint, lamports, minTokensOut: min, buybackRecipient: recipients[0] })
    ];
  }

  async function buildBuy(c, buyerPk, mint, curve, sol, slippageBps) {
    const glob = await readGlobal(c);
    return toTx(c, budget(c, CU.buy).concat(buyInstructions(c, buyerPk, mint, curve, sol, slippageBps, glob)), buyerPk);
  }

  // Every address the launch transactions share between launches: found by building them for two throwaway coins
  // and wallets and keeping what matches. This is what goes in the lookup table.
  async function lookupAddresses() {
    const c = await chain();
    const glob = await readGlobal(c);
    const fresh = { virtual_token_reserves: glob.initial_virtual_token_reserves, virtual_quote_reserves: glob.initial_virtual_sol_reserves, real_token_reserves: glob.initial_real_token_reserves };
    const one = () => {
      const user = c.web3.Keypair.generate().publicKey, mint = c.web3.Keypair.generate().publicKey;
      const ixs = [c.B.createCoin({ mint, user, name: 'Check', symbol: 'CHK', uri: 'https://example.com/meta.json' })]
        .concat(buyInstructions(c, user, mint.toBase58(), fresh, 0.1, 1000, glob))
        .concat([c.B.sweepCreatorFee({ payer: user, mint, creator: user }), c.B.createSharingConfig({ mint, payer: user }),
          c.B.setShares({ mint, authority: user, shareholders: shares(user.toBase58()), currentShareholders: [user] })]);
      const keys = new Set();
      ixs.forEach(ix => { keys.add(ix.programId.toBase58()); ix.keys.forEach(k => keys.add(k.pubkey.toBase58())); });
      budget(c, 1).forEach(ix => keys.add(ix.programId.toBase58()));
      return keys;
    };
    const a = one(), b = one();
    return Array.from(a).filter(k => b.has(k));
  }

  async function status(sig, ctx) {
    if (!enabled) return { status: 503, body: { error: 'launch_unavailable' } };
    if (!allowRead((ctx && ctx.ip) || 'unknown')) return { status: 429, body: { error: 'rate_limited' } };
    if (typeof sig !== 'string' || !SIG_RE.test(sig)) return { status: 400, body: { error: 'bad_signature' } };
    try {
      const c = await chain();
      const r = await c.connection.getSignatureStatuses([sig], { searchTransactionHistory: true });
      const st = r && r.value && r.value[0];
      if (!st) return { status: 200, body: { state: 'pending' } };
      if (st.err) return { status: 200, body: { state: 'failed' } };
      const done = st.confirmationStatus === 'confirmed' || st.confirmationStatus === 'finalized';
      return { status: 200, body: { state: done ? 'confirmed' : 'pending' } };
    } catch (err) {
      logger.error('Launch status failed: ' + (err && err.message ? err.message : 'unknown error'));
      return { status: 502, body: { error: 'status_failed' } };
    }
  }

  // The curve's state, with no rate limit. For the server's own use (the public list of launches).
  // `mint` is the coin's token address; the curve address is derived from it.
  async function inspect(mint) {
    if (!enabled) return { status: 503, body: { error: 'launch_unavailable' } };
    if (typeof mint !== 'string' || !B58_RE.test(mint)) return { status: 400, body: { error: 'bad_pool' } };
    try {
      const c = await chain();
      const curve = await readCurve(c, mint);
      if (!curve) return { status: 404, body: { error: 'pool_not_found' } };
      const glob = await readGlobal(c);
      // A coin paired with another token counts in that token's own units, and starts from its own virtual reserves.
      const quote = await quoteOfCurve(c, curve);
      const unitDiv = quote ? Math.pow(10, quote.decimals) : 1e9;
      const need = quote
        ? Number(pump.solToFill({ initial_virtual_token_reserves: glob.initial_virtual_token_reserves, initial_virtual_sol_reserves: curve.initial_virtual_quote_reserves, initial_real_token_reserves: glob.initial_real_token_reserves })) / unitDiv
        : Number(pump.solToFill(glob)) / 1e9;
      const startReal = Number(glob.initial_real_token_reserves) || 1;
      const left = Number(curve.real_token_reserves);
      const progress = Math.max(0, Math.min(1, 1 - left / startReal));
      const vt = Number(curve.virtual_token_reserves) || 1;
      const marketCapSol = (Number(curve.virtual_quote_reserves) / vt) * Number(curve.token_total_supply) / unitDiv;
      const complete = Boolean(curve.complete);
      return {
        status: 200,
        body: {
          address: mint, curve: c.B.bondingCurveOf(mint).toBase58(), mint,
          raisedSol: complete ? need : Number(curve.real_quote_reserves) / unitDiv, thresholdSol: need,
          paired: Boolean(quote), pairMint: quote ? quote.mint.toBase58() : '',
          progress: complete ? 1 : progress, marketCapSol,
          migrated: complete, curveFull: complete,
          splitOk: Boolean(curve.is_holder_reward) || curve.creator === c.B.sharingConfigOf(mint).toBase58(), holderRewards: Boolean(curve.is_holder_reward), cluster
        }
      };
    } catch (err) {
      logger.error('Launch pool read failed: ' + (err && err.stack ? err.stack : 'unknown error'));
      return { status: 502, body: { error: 'pool_read_failed' } };
    }
  }

  async function pool(mint, ctx) {
    if (!enabled) return { status: 503, body: { error: 'launch_unavailable' } };
    if (!allowRead((ctx && ctx.ip) || 'unknown')) return { status: 429, body: { error: 'rate_limited' } };
    return inspect(mint);
  }

  // Builds an unsigned buy for the buyer's wallet to sign.
  async function buy(input, ctx) {
    if (!enabled) return { status: 503, body: { error: 'launch_unavailable' } };
    if (!allow((ctx && ctx.ip) || 'unknown')) return { status: 429, body: { error: 'rate_limited' } };
    const b = input && typeof input === 'object' ? input : {};
    if (typeof b.pool !== 'string' || !B58_RE.test(b.pool)) return { status: 400, body: { error: 'bad_pool' } };
    if (typeof b.buyer !== 'string' || !B58_RE.test(b.buyer)) return { status: 400, body: { error: 'bad_buyer' } };
    // A pad's owner can block wallets from buying through this site. (Anyone can still buy on pump.fun itself.)
    if (ctx && typeof ctx.isDenied === 'function' && ctx.isDenied(b.pool, b.buyer)) return { status: 403, body: { error: 'denied' } };
    const sol = Number(b.sol);
    if (!Number.isFinite(sol) || sol <= 0 || sol > 1e12) return { status: 400, body: { error: 'bad_amount' } };
    try {
      const c = await chain();
      const curve = await readCurve(c, b.pool);
      if (!curve) return { status: 404, body: { error: 'pool_not_found' } };
      if (curve.complete) return { status: 409, body: { error: 'migrated' } };
      const buyerPk = new c.web3.PublicKey(b.buyer);
      const quote = await quoteOfCurve(c, curve);
      if (quote) {
        // Buying with a pair token is off until it has been proven (PAIRS_TRADE=yes). The buyer pays in the pair token.
        if (!o.pairTrade) return { status: 409, body: { error: 'pair_trade_not_ready' } };
        const amount = BigInt(Math.floor(sol * Math.pow(10, quote.decimals)));
        let have = 0n;
        try {
          const bal = await c.connection.getTokenAccountBalance(c.B.ata(buyerPk, quote.mint, quote.program));
          have = BigInt(bal && bal.value ? bal.value.amount : 0);
        } catch (e) { have = 0n; }
        if (have < amount) return { status: 409, body: { error: 'no_pair_balance' } };
        const glob = await readGlobal(c);
        const min = pump.minTokensForBuy(curve, amount, 500, pump.feeGuessBps(glob));
        if (min <= 0n) return { status: 400, body: { error: 'bad_amount' } };
        const recipients = Array.isArray(glob.buyback_fee_recipients) && glob.buyback_fee_recipients.length ? glob.buyback_fee_recipients : pump.BUYBACK_RECIPIENTS;
        // For a coin paired with a token, the buyback fee recipient is that wallet's token account for the pair token,
        // which the trade checks and never creates, so it is created here first if it is missing.
        const buybackWallet = new c.web3.PublicKey(recipients[0]);
        const ixs = [c.B.createAtaIdempotent(buyerPk, buyerPk, b.pool, pump.TOKEN_2022),
          c.B.createAtaIdempotent(buyerPk, buybackWallet, quote.mint, quote.program),
          c.B.buyExactIn({ user: buyerPk, mint: b.pool, lamports: amount, minTokensOut: min, buybackRecipient: c.B.ata(buybackWallet, quote.mint, quote.program), quote })];
        return { status: 200, body: { transaction: await toTx(c, budget(c, CU.buy).concat(ixs), buyerPk), partialFill: false, cluster } };
      }
      if (sol < MIN_BUY_SOL || sol > MAX_BUY_SOL) return { status: 400, body: { error: 'bad_amount' } };
      const transaction = await buildBuy(c, buyerPk, b.pool, curve, sol, 500);
      return { status: 200, body: { transaction, partialFill: false, cluster } };
    } catch (err) {
      logger.error('Launch buy failed: ' + (err && err.stack ? err.stack : 'unknown error'));
      return { status: 502, body: { error: isMain && /quote/.test(String(err && err.message)) ? 'quote_failed' : 'prepare_failed' } };
    }
  }

  // Creator fees waiting for a coin: the part still on the curve plus what has been swept into the fee vault.
  async function pending(c, mint, curve) {
    const quote = await quoteOfCurve(c, curve);
    if (quote) {
      // Paired coins keep their waiting fees as the pair token, in a token account owned by the fee vault.
      let amount = Number(curve.creator_fee || 0n);
      try {
        const bal = await c.connection.getTokenAccountBalance(c.B.ata(c.B.creatorVaultOf(curve.creator), quote.mint, quote.program));
        amount += Number(bal && bal.value ? bal.value.amount : 0);
      } catch (e) { /* no token account yet */ }
      return amount / Math.pow(10, quote.decimals);
    }
    let waiting = Number(curve.creator_fee || 0n);
    try {
      const vault = c.B.creatorVaultOf(curve.creator);
      const acc = await c.connection.getAccountInfo(vault);
      if (acc) {
        const rent = await c.connection.getMinimumBalanceForRentExemption(acc.data.length);
        waiting += Math.max(0, Number(acc.lamports) - rent);
      }
    } catch (e) { /* keep what the curve shows */ }
    return waiting / 1e9;
  }

  async function fees(mint, ctx) {
    if (!enabled) return { status: 503, body: { error: 'launch_unavailable' } };
    if (!allowRead((ctx && ctx.ip) || 'unknown')) return { status: 429, body: { error: 'rate_limited' } };
    if (typeof mint !== 'string' || !B58_RE.test(mint)) return { status: 400, body: { error: 'bad_pool' } };
    try {
      const c = await chain();
      const curve = await readCurve(c, mint);
      if (!curve) return { status: 404, body: { error: 'pool_not_found' } };
      // A holder rewards coin pays its creator fee to its holders through pump.fun: nothing waits here and nothing is split.
      if (curve.is_holder_reward) return { status: 200, body: { mint, holderRewards: true, paired: false, pairMint: '', pendingSol: 0, splitOk: true, creatorPct: 0, platformPct: 0, shares: [], platformWallet, cluster } };
      const splitOk = curve.creator === c.B.sharingConfigOf(mint).toBase58();
      const feeQuote = await quoteOfCurve(c, curve);
      // Who gets what is read from the coin's own fee split on-chain, so a pad's owner share shows up too.
      let holders = [];
      if (splitOk) {
        try {
          const acc = await c.connection.getAccountInfo(c.B.sharingConfigOf(mint));
          const cfg = acc ? pump.decodeAccount(pump.IDLS.fees, 'SharingConfig', acc.data, c.web3) : null;
          holders = ((cfg && cfg.shareholders) || []).map(h => ({ address: String(h.address), pct: Number(h.share_bps) / 100 }));
        } catch (e) { holders = []; }
      }
      const platformHeld = holders.find(h => h.address === platformWallet);
      const pp = platformHeld ? platformHeld.pct : platformPct;
      return { status: 200, body: { mint, paired: Boolean(feeQuote), pairMint: feeQuote ? feeQuote.mint.toBase58() : '', pendingSol: await pending(c, mint, curve), splitOk, creatorPct: 100 - pp, platformPct: pp, shares: holders, platformWallet, cluster } };
    } catch (err) {
      logger.error('Launch fees read failed: ' + (err && err.stack ? err.stack : 'unknown error'));
      return { status: 502, body: { error: 'fees_read_failed' } };
    }
  }

  // Builds an unsigned payout of a coin's waiting creator fees to its shareholders. Anyone can send it: it only
  // moves money to the wallets in the coin's fee split, and the sender pays the network fee.
  async function distribute(input, ctx) {
    if (!enabled) return { status: 503, body: { error: 'launch_unavailable' } };
    if (!allow((ctx && ctx.ip) || 'unknown')) return { status: 429, body: { error: 'rate_limited' } };
    const b = input && typeof input === 'object' ? input : {};
    if (typeof b.pool !== 'string' || !B58_RE.test(b.pool)) return { status: 400, body: { error: 'bad_pool' } };
    if (typeof b.payer !== 'string' || !B58_RE.test(b.payer)) return { status: 400, body: { error: 'bad_creator' } };
    try {
      const c = await chain();
      const curve = await readCurve(c, b.pool);
      if (!curve) return { status: 404, body: { error: 'pool_not_found' } };
      if (curve.complete) return { status: 409, body: { error: 'migrated' } };
      if (curve.is_holder_reward) return { status: 409, body: { error: 'holder_rewards' } };
      if (curve.creator !== c.B.sharingConfigOf(b.pool).toBase58()) return { status: 409, body: { error: 'split_not_set' } };
      const waiting = await pending(c, b.pool, curve);
      if (waiting < 0.00001) return { status: 409, body: { error: 'nothing_to_claim' } };
      const acc = await c.connection.getAccountInfo(c.B.sharingConfigOf(b.pool));
      const cfg = pump.decodeAccount(pump.IDLS.fees, 'SharingConfig', acc.data, c.web3);
      const holders = (cfg.shareholders || []).map(s => s.address);
      if (!holders.length) throw new Error('fee split has no shareholders');
      const payerPk = new c.web3.PublicKey(b.payer);
      const quote = await quoteOfCurve(c, curve);
      const ixs = [
        c.B.sweepCreatorFee({ payer: payerPk, mint: b.pool, creator: curve.creator, quote }),
        c.B.distribute({ payer: payerPk, mint: b.pool, shareholders: holders.map(a => new c.web3.PublicKey(a)), quote })
      ];
      return { status: 200, body: { transaction: await toTx(c, budget(c, CU.distribute).concat(ixs), payerPk), waitingSol: waiting, cluster } };
    } catch (err) {
      logger.error('Launch distribute failed: ' + (err && err.stack ? err.stack : 'unknown error'));
      return { status: 502, body: { error: 'prepare_failed' } };
    }
  }


  // The pairing tokens pump.fun allows for new coins (its "custom pair" list), read from its quote-control account.
  // PAIRS_RPC_URL can point at mainnet so the list can be previewed while launching runs on devnet. Cached for an hour.
  const pairsRpc = o.pairsRpcUrl || rpcUrl;
  let pairsCache = null;
  async function pairs() {
    const nowMs = (o.now || Date.now)();
    if (pairsCache && nowMs - pairsCache.at < 3600000) return { status: 200, body: pairsCache.value };
    if (!pairsRpc) return { status: 503, body: { error: 'pairs_unavailable' } };
    try {
      const { web3 } = await load();
      const connection = new web3.Connection(pairsRpc, 'confirmed');
      const [qc] = web3.PublicKey.findProgramAddressSync([Buffer.from('quote-control')], new web3.PublicKey(pump.PUMP));
      const acc = await connection.getAccountInfo(qc);
      const list = [];
      if (acc) {
        const d = Buffer.from(acc.data);
        const start = 8 + 32 + 32 + 32 + 4;
        const count = d.length >= start ? d.readUInt32LE(start - 4) : 0;
        for (let i = 0; i < count && start + (i + 1) * 40 <= d.length; i++) {
          list.push({ mint: new web3.PublicKey(d.subarray(start + i * 40, start + i * 40 + 32)).toBase58() });
        }
      }
      // Names and symbols, through the RPC's asset lookup (Helius has it). Without it a pair shows as its address.
      const meta = {};
      const doFetch = o.fetch || (typeof fetch === 'function' ? fetch : null);
      if (list.length && doFetch) {
        try {
          const res = await doFetch(pairsRpc, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'getAssetBatch', params: { ids: list.map(x => x.mint) } }), signal: AbortSignal.timeout(15000) });
          const j = await res.json();
          (j.result || []).forEach(a => { if (a && a.id && a.content && a.content.metadata) meta[a.id] = { symbol: String(a.content.metadata.symbol || ''), name: String(a.content.metadata.name || '') }; });
        } catch (e) { logger.error('Pair names lookup failed: ' + (e && e.message)); }
      }
      const out = list.map(x => {
        const m = meta[x.mint] || { symbol: '', name: '' };
        const symbol = m.symbol.replace(/[^\w.\-$]/g, '').slice(0, 12) || x.mint.slice(0, 4) + '…';
        const name = m.name.replace(/[\u0000-\u001f<>]/g, '').slice(0, 60) || symbol;
        return { mint: x.mint, symbol, name, kind: /stock|securities|\betf\b/i.test(m.name) ? 'stock' : 'other' };
      }).filter(x => o.showStocks || x.kind !== 'stock').sort((a, b) => (a.kind === b.kind ? a.symbol.localeCompare(b.symbol) : a.kind === 'stock' ? -1 : 1));
      const value = { pairs: out, cluster: pairsRpc === rpcUrl ? cluster : 'mainnet-beta', launchReady: pairsRpc === rpcUrl };
      pairsCache = { at: nowMs, value };
      return { status: 200, body: value };
    } catch (err) {
      logger.error('Pair list read failed: ' + (err && err.message ? err.message : 'unknown error'));
      return { status: 502, body: { error: 'pairs_failed' } };
    }
  }

  // USD price of each pair token, from the RPC's asset lookup (Helius reports a price for the well-known ones). Cached for a minute.
  // A token with no known price is simply left out, and the page then shows only the token amount.
  const priceCache = new Map();
  async function pairPrices(mints) {
    const nowMs = (o.now || Date.now)();
    const want = Array.from(new Set((mints || []).filter(m => typeof m === 'string' && B58_RE.test(m))));
    const stale = want.filter(m => { const h = priceCache.get(m); return !h || nowMs - h.at > 60000; });
    const doFetch = o.fetch || (typeof fetch === 'function' ? fetch : null);
    if (stale.length && pairsRpc && doFetch) {
      try {
        const res = await doFetch(pairsRpc, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'getAssetBatch', params: { ids: stale } }), signal: AbortSignal.timeout(8000) });
        const j = await res.json();
        const got = new Set();
        (j.result || []).forEach(a => {
          const price = a && a.token_info && a.token_info.price_info ? Number(a.token_info.price_info.price_per_token) : NaN;
          if (a && a.id) { got.add(a.id); priceCache.set(a.id, { at: nowMs, usd: Number.isFinite(price) && price > 0 ? price : null }); }
        });
        stale.forEach(m => { if (!got.has(m)) priceCache.set(m, { at: nowMs, usd: null }); });
      } catch (e) { logger.error('Pair price lookup failed: ' + (e && e.message)); stale.forEach(m => { if (!priceCache.has(m)) priceCache.set(m, { at: nowMs - 45000, usd: null }); }); }
    }
    const out = {};
    want.forEach(m => { const h = priceCache.get(m); if (h && h.usd !== null) out[m] = h.usd; });
    return out;
  }

  // What the chain shows about a coin's holders and recent trading, for the mascot's report. Cached for a minute.
  const activityCache = new Map();
  async function activity(mint, ctx) {
    if (!enabled) return { status: 503, body: { error: 'launch_unavailable' } };
    if (typeof mint !== 'string' || !B58_RE.test(mint)) return { status: 400, body: { error: 'bad_pool' } };
    const nowMs = (o.now || Date.now)();
    const hit = activityCache.get(mint);
    if (hit && nowMs - hit.at < 60000) return { status: 200, body: hit.value };
    if (!allowRead((ctx && ctx.ip) || 'unknown')) return { status: 429, body: { error: 'rate_limited' } };
    try {
      const c = await chain();
      const curve = await readCurve(c, mint);
      if (!curve) return { status: 404, body: { error: 'pool_not_found' } };
      const curvePda = c.B.bondingCurveOf(mint);
      const supply = Number(curve.token_total_supply) || 0;
      const value = { holders: null, holdersCapped: false, topHolderPct: null, onCurvePct: null, trades: null, lastTradeAt: null, tradesLastHour: null };
      try {
        const big = await c.connection.getTokenLargestAccounts(new c.web3.PublicKey(mint));
        const rows = (big && big.value) || [];
        const infos = rows.length ? await c.connection.getMultipleAccountsInfo(rows.map(r => new c.web3.PublicKey(r.address))) : [];
        let holders = 0, top = 0, onCurve = 0;
        rows.forEach((r, i) => {
          const amt = Number(r.amount) || 0;
          const data = infos[i] && infos[i].data;
          const owner = data && data.length >= 64 ? new c.web3.PublicKey(data.slice(32, 64)).toBase58() : '';
          if (owner === curvePda.toBase58()) { onCurve += amt; return; }
          if (amt > 0) { holders++; top = Math.max(top, amt); }
        });
        value.holders = holders; value.holdersCapped = rows.length >= 20;
        if (supply > 0) { value.topHolderPct = Math.round(top / supply * 1000) / 10; value.onCurvePct = Math.round(onCurve / supply * 1000) / 10; }
      } catch (e) { /* holders stay unknown */ }
      try {
        const sigs = (await c.connection.getSignaturesForAddress(curvePda, { limit: 25 })) || [];
        const ok = sigs.filter(s => !s.err);
        value.trades = ok.length;
        const times = ok.map(s => Number(s.blockTime) || 0).filter(Boolean);
        if (times.length) {
          value.lastTradeAt = Math.max.apply(null, times) * 1000;
          value.tradesLastHour = times.filter(t => nowMs - t * 1000 < 3600000).length;
        }
      } catch (e) { /* trades stay unknown */ }
      activityCache.set(mint, { at: nowMs, value });
      return { status: 200, body: value };
    } catch (err) {
      logger.error('Coin activity read failed: ' + (err && err.message ? err.message : 'unknown error'));
      return { status: 502, body: { error: 'activity_failed' } };
    }
  }

  // What the platform has earned and not yet been paid, per coin. `mints` is the list of HatchPad launches.
  async function partnerFees(ctx) {
    if (!enabled) return { status: 503, body: { error: 'launch_unavailable' } };
    if (!allowRead((ctx && ctx.ip) || 'unknown')) return { status: 429, body: { error: 'rate_limited' } };
    try {
      const c = await chain();
      const list = [];
      for (const mint of (ctx && ctx.mints) || []) {
        const curve = await readCurve(c, mint).catch(() => null);
        if (!curve || curve.creator !== c.B.sharingConfigOf(mint).toBase58()) continue;
        // A coin that graduated to its trading pool pays its fees out on pump.fun, so nothing can be sent out here.
        const done = Boolean(curve.complete);
        const total = done ? 0 : await pending(c, mint, curve);
        const paired = Boolean(await quoteOfCurve(c, curve));
        list.push({ pool: mint, preset: '', waitingSol: total * platformPct / 100, totalSol: total, migrated: done, paired });
      }
      list.sort((a, b) => b.waitingSol - a.waitingSol);
      return { status: 200, body: { feeClaimers: [platformWallet], pools: list, totalWaitingSol: list.reduce((s, p) => s + (p.paired ? 0 : p.waitingSol), 0), cluster } };
    } catch (err) {
      logger.error('Partner fee read failed: ' + (err && err.stack ? err.stack : 'unknown error'));
      return { status: 502, body: { error: 'fees_read_failed' } };
    }
  }

  return { info, lookupAddresses, prepare, step, status, pool, inspect, buy, fees, distribute, partnerFees, activity, pairs, pairPrices };
}

// Metadata for the token, read by wallets and explorers. Built from the link and the stored animal, so the
// page never has to host anything else. `art` is the stored record for the picture, if there is one.
function metadataFor(name, symbol, art, base, cluster) {
  const n = cleanText(name, 32);
  const s = typeof symbol === 'string' ? symbol.replace(/^\$/, '').trim().toUpperCase() : '';
  if (!n || !SYMBOL_RE.test(s)) return null;
  const description = art && art.description ? cleanText(art.description, 200) : (cluster === 'mainnet-beta' ? 'A coin launched on HatchPad.' : 'A devnet test token launched on HatchPad.');
  const meta = { name: n, symbol: s, description, image: art && art.id && base ? base + '/art/' + art.id + '.' + (art.ext === 'jpg' ? 'jpg' : 'png') : '' };
  // The creator's own links, in the field names wallets and explorers read.
  const links = art && art.links && typeof art.links === 'object' ? art.links : {};
  if (links.website) { meta.external_url = links.website; meta.website = links.website; }
  if (links.twitter) meta.twitter = links.twitter;
  if (links.telegram) meta.telegram = links.telegram;
  if (links.website || links.twitter || links.telegram) meta.extensions = Object.assign({}, links.website ? { website: links.website } : {}, links.twitter ? { twitter: links.twitter } : {}, links.telegram ? { telegram: links.telegram } : {});
  return meta;
}

module.exports = { createLauncher, metadataFor, cleanText };
