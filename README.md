# NoVampPad

A pump.fun launchpad where every coin must be an original. Before a coin is built, the server checks it against every coin already launched here: the same ticker, the same name, or a picture that looks the same is refused. One site, one launchpad. Creator fees are shared on-chain by pump.fun's fee sharing: 90% to the wallet that launched the coin, 10% to the platform.

## How the rule works

- **Ticker and name** are compared as "skeletons": case, punctuation and look-alike characters are ignored (PEPE, P3P3 and Pépé are one ticker), and filler words such as "The", "Coin" and "Official" are ignored in names.
- **Picture** is compared by how it looks (a 64-bit difference hash, via the `sharp` library), so resizing or changing a few pixels does not make a new picture. If `sharp` cannot be loaded, it falls back to an exact file match.
- **Holds:** when a launch is prepared, its ticker, name and picture are held for 10 minutes so two people cannot both pass the check. A failed launch releases the hold; a coin that exists on-chain is confirmed for good.
- The list of originals is stored in `originals[.cluster].json` in `DATA_DIR`.
- It only covers coins launched on this site. Anyone can still launch a copy on pump.fun.

Everything below is inherited from BuildAPad, the code this was started from. The pad builder is switched off here (`/build` and the pad-building API answer 404). The site's one launchpad is made at start from `pads/novamppad.json` and `FOUNDER_WALLET`/`PLATFORM_FEE_WALLET`.

---

# BuildAPad

Build your own Solana launchpad in a minute. Pick a name, upload a logo, choose an accent color, your cut of the creator fees, and which wallet receives it. Sign once with your wallet and you get a live launchpad page at `/p/<your-name>` where anyone can launch a coin on pump.fun, and you earn from every one.

**Status:** runs on pump.fun. The launch, fee split, first buy and payout have been tested end to end on devnet. Devnet is the default; mainnet is refused in code until `MAINNET_ENABLED=yes`. Run `devnet/11-check-pump.mjs` before real money.

## How it works

1. **Build a pad (`/build`):** the owner picks a name, page address, tagline, logo (PNG or JPEG, resized in the browser), accent color, corner style, optional links, and their fee share. A live preview follows every choice. The owner's wallet signs a message (no cost) that names the page, the wallet and the share, and the server checks the signature before saving the pad.
2. **Launch a coin (`/p/<slug>`):** a visitor enters a name, ticker, optional description and a picture, then Phantom signs the transactions the server prepares: `create_v2` (with an optional first buy in the same transaction when a lookup table is set), then the three-way fee split. If a step is declined or the tab closes, pressing Launch again continues from what is on-chain.
3. **Fees, split three ways on-chain:** pump.fun's own fee sharing pays the coin's launcher, the pad owner and the platform. The platform share is fixed by the operator (`PLATFORM_SHARE_PCT`); the owner picks their share from 0 up to `50 - platform share`; the launcher keeps the rest, always at least half.
4. **Leaderboard (`/`):** the home page ranks pads by confirmed coins launched on them, then by SOL raised (`GET /api/leaderboard`). Raised amounts are as last looked at on-chain and refresh when the recent-launches list refreshes.
5. **Send out fees:** anyone can press Send out fees on a coin page. The money goes to the wallets in that coin's split. The operator's `/admin` page lists the platform's share and sends it out.

## Run it

```
npm install
PLATFORM_FEE_WALLET=<public address> node server.js
```

`/healthz` and the startup log name any missing setting (never its value). Without `PLATFORM_FEE_WALLET` launching and building are switched off.

| Variable | Purpose |
| --- | --- |
| `PLATFORM_FEE_WALLET` | Public address that receives the platform's share. Required. Use a fresh wallet or a Ledger. |
| `HOLDER_REWARDS` | Set `yes` to allow holder-rewards pads (pump.fun's native holder-rewards coins). Mainnet only. |
| `HOLDER_LAUNCH_FEE_SOL` | Flat launch fee paid to `PLATFORM_FEE_WALLET` on holder-rewards pads. Default 0.05. |
| `PLATFORM_SHARE_PCT` | The platform's share of creator fees, whole number 1 to 50. Suggested 10. It is written on-chain at launch and cannot change for that coin. |
| `DATA_DIR` | Where the volume is mounted (for example `/data`). **Required for pads to survive a deploy**: pads are saved in `<DATA_DIR>/padstore.json`, pad logos in `<DATA_DIR>/pad-logos`, coin pictures in `<DATA_DIR>/art`, the launch list in `<DATA_DIR>/launches.json`. Defaults to `/data` when that folder exists, otherwise memory only. |
| `LAUNCH_CLUSTER` | `devnet` (default) or `mainnet-beta`. |
| `MAINNET_ENABLED` | Must be `yes` for `mainnet-beta`. Without it the server refuses to start. |
| `LAUNCH_RPC_URL` | RPC address. Devnet defaults to the public one. Mainnet requires a dedicated paid RPC. |
| `LAUNCH_LOOKUP_TABLE` | Frozen lookup table made by `devnet/12-make-lookup-table.mjs`. With it, creating the coin and the creator's first buy are one transaction, so nobody can buy first. |
| `PRIORITY_FEE_MICROLAMPORTS` | Priority fee per compute unit. Default 50000 on mainnet, 0 on devnet. |
| `PAD` | Which `pads/<name>.json` sets the home page brand. Default `novamppad`. |
| `PUBLIC_URL` | This site's address, if it can't be worked out from the request. |
| `LAUNCHES_FILE`, `HIDE_POOLS` | Optional. Move the launch list; hide pools from public lists. |
| `ART_DIR`, `VERIFY_SECRET` | Optional. Coin picture folder; secret for website-check codes (created on the volume if unset). |
| `IMAGE_PROVIDER`, `CLOUDFLARE_ACCOUNT_ID`, `CLOUDFLARE_API_TOKEN`, `OPENAI_API_KEY`, `IMAGE_MODEL`, `TEXT_MODEL`, `ART_PER_IP_PER_HOUR`, `ART_DAILY_CAP` | Optional AI picture and chat settings, used only where a pad offers them. |
| `FOUNDER_WALLET` | Optional. Only this wallet can stage the founder coin. |

## Pad rules

- Names and page addresses are checked against a blocked list of well-known people and brands, and a reserved list (`build`, `admin`, `api`, ...). Pages are 3 to 30 letters, numbers or dashes.
- The owner's fee share can go to a different payout wallet (a Ledger, a team wallet). The signed message names it, so it cannot be swapped afterwards.
- Creating a pad needs a wallet signature (valid for 10 minutes). Limits: 3 pads per wallet, 5 creations per connection per hour.
- Logos are checked by their first bytes (PNG or JPEG, up to 400 KB). SVG is refused.
- Colors are hex only, fonts Google Fonts only, and all text is escaped, so a pad cannot add markup or script.
- The owner can change a pad later at `/build?edit=<name>` (an Edit button shows on the pad page for the owner's wallet). It needs one signature. The name, page address, fee share and payout wallet cannot change.

## Pad options

Each pad can switch these on when it is built or edited:

| Option | What it does |
| --- | --- |
| About text, banner | Shown at the top of the pad page. The banner is a PNG or JPEG (resized to 1200 by 400 in the browser). |
| AI coin maker | Launchers describe an idea and AI draws the logo and suggests a name, ticker and description. The owner can set a picture style. Costs money, so each pad has a daily limit (`PAD_AI_DAILY_CAP`, default 30). Off by default. Needs an image provider key. |
| Mascot chat | A chat on every coin page, with a mascot name and personality set by the owner. On by default, each pad limited to 200 messages a day (`PAD_CHAT_DAILY_CAP`). The mascot never gives financial advice or writes links. |
| Required first buy | Launchers must buy at least a set amount (0.01 to 5 SOL) when creating the coin. It is checked on the server when the launch is prepared. With a lookup table the buy is in the same transaction; without one it is a later step a launcher could decline. |
| Private pad | If the allow list has wallets, only those wallets (and the owner) can launch coins on the pad. |
| Blocked wallets | Up to 100 wallets that cannot launch on the pad or buy its coins through this site. The owner is never blocked. |

The wallet lists are checked on the server and are not put in the page, but they are readable through `GET /api/pads/<name>` (wallet addresses are public on-chain anyway). Blocking only covers this site. Anyone can still buy a coin directly on pump.fun, and nothing on our side can stop that.

### Turning on AI (Railway variables)

For Cloudflare Workers AI set: `IMAGE_PROVIDER=cloudflare`, `CLOUDFLARE_ACCOUNT_ID=<32-character account id>`, `CLOUDFLARE_API_TOKEN=<token with Workers AI access>`. Keep the token in Railway only. Optional spending caps: `ART_DAILY_CAP` (all pads together, default 300 pictures a day), `ART_PER_IP_PER_HOUR`, `PAD_AI_DAILY_CAP` (per pad), `PAD_CHAT_DAILY_CAP`.

`pads/*.json` are operator brand files for the home page (`PAD`). `pads/buildapad.json` is the default; `hatchpad.json` and `robots.json` are older samples.

## Guardrails and limits

- Coin names and descriptions are cleaned and checked against a basic blocked list. It is not complete. `HIDE_POOLS` removes anything else by hand.
- The three-way split is enforced for coins launched through the site's own flow. Someone who builds their own transactions can launch without it, so coin pages and `/admin` count only coins whose split is in place (`splitOk`).
- Not built yet: a flat launch fee to the pad owner (it changes the on-chain create transaction, so it waits for a proven devnet run), private pads, launch rules, selling from the page, payouts after a coin moves to PumpSwap, pad editing, a per-owner fee dashboard, IPFS storage, a security review for mainnet.

## Scripts

`devnet/` holds command-line helpers (throwaway keys, payer wallet, sweep script, `11-check-pump.mjs` which simulates the pump.fun transactions without spending anything, `12-make-lookup-table.mjs`). See `devnet/README.md`.

## How pump.fun is used

`pump.js` builds instructions straight from pump.fun's published IDL (`idl/pump.json`, `idl/pump_fees.json`): `create_v2`, `create_fee_sharing_config`, `update_fee_shares_v2`, `buy_exact_quote_in_v3`, `sell_v3`, `sweep_creator_fee` and `distribute_creator_fees_v2`. The only dependency is `@solana/web3.js`. Creator fees stay on the curve, so a payout is sweep then distribute in one transaction. Fees earned before the split is set go entirely to the launcher.

## Other pages

- `/coin/<pool>`: coin details, trading, fee status, Send out fees (and Finish setup for the creator if the split step was skipped), website verification and share/Blink links.
- `/admin`: connect the platform wallet to see and send out its share.

## The official coin (`/admin/launch`)

An admin-only page launches the site's own coin (default name BuildAPad, ticker BUILD) with the logo in `pads/buildapad/assets/founder-logo.png`. Connect the admin wallet, add links and an optional first buy, and launch. The admin wallet is `FOUNDER_WALLET`, or `PLATFORM_FEE_WALLET` if that is not set. Only that wallet can launch the coin (checked on the server, and the wallet has to sign it). Once it is on-chain, the home page shows an "official coin" box with its address. Optional text settings: `FOUNDER_NAME`, `FOUNDER_SYMBOL`, `FOUNDER_DESCRIPTION`. The fee split is the usual one: the platform share to `PLATFORM_FEE_WALLET`, the rest to the launcher.

## Going live on mainnet

Real money. Get a legal and security review first.

1. Make a NEW platform fee wallet (fresh Phantom account, Ledger or multisig). Only its public address goes on the server.
2. Simulate: `CLUSTER=mainnet-beta MAINNET_OK=yes RPC_URL=<rpc> node 11-check-pump.mjs <wallet> <mint of a live pump.fun coin>` from `devnet/`.
3. Make the lookup table once with `12-make-lookup-table.mjs <platform fee wallet>` and use its address as `LAUNCH_LOOKUP_TABLE`.
4. On Railway set `LAUNCH_CLUSTER=mainnet-beta`, `MAINNET_ENABLED=yes`, `LAUNCH_RPC_URL`, `PLATFORM_FEE_WALLET`, `PLATFORM_SHARE_PCT`, `LAUNCH_LOOKUP_TABLE`, and keep the volume mounted.
5. Build one pad and launch one small coin first, then check `/admin`.

### Pool pair (preview)

A pad can pick a pool pair from pump.fun's on-chain custom pair list (stocks, crypto, others). The list is read from pump.fun's quote-control account. On a devnet server, set `PAIRS_RPC_URL` to a mainnet RPC address (read-only) to preview the picker; without it the picker stays hidden. Launching coins on a paired pad is not switched on yet: the server answers `pair_not_ready`.

## Holder-rewards pads

An owner can tick **Reward holders** when building a pad. Every coin launched there is a pump.fun holder-rewards coin: all creator fees go to the coin's holders automatically, with nothing to claim and no fee split. Because pump.fun controls the coin's fee setup, no percentage cut is possible, so the platform charges the launcher a flat fee (`HOLDER_LAUNCH_FEE_SOL`, default 0.05 SOL) in the launch transaction. The pad owner earns nothing. The option is fixed once a pad is built, cannot be combined with a pool pair, and a first buy at launch is not supported yet. pump.fun can switch holder-rewards creation off, and then launches fail until it is back.
