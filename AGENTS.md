# PROJECT KNOWLEDGE BASE

**Generated:** 2026-09-24

## OVERVIEW
Node.js >= 20 ESM batch CLI (`type: module`, no build step — plain JS + JSDoc types, `tsc --noEmit` only).
Syncs IPv4/IPv6 blocklist feeds into a Cloudflare List, then mirrors that reference set add-only into a cdnfly-class WAF panel and GoEdge/EdgeAdmin IP lists; a systemd timer (cf-blocklist-sync.timer) runs it daily 12:00 Asia/Kuala_Lumpur.

## STRUCTURE
```
/root/CF_blacklis
├── run_sync.js            # only entry point: shebang, calls main(), maps return to exit code
├── src/
│   ├── main.js            # main(): orchestrates feeds → Cloudflare → CDNs; returns 0/1
│   ├── config.js          # loadConfig + ENV_FILE (resolves to ../.env, i.e. the project root)
│   ├── ip.js              # parseEntry/normalizeCfItem — shared by the feed parser and both CDN clients
│   ├── http.js            # shared timeout budget (FETCH/PUSH_TIMEOUT_MS), timedOut, trimTrailingSlash
│   ├── feed.js            # fetchFeed, mergeFeeds (union of feed entries)
│   ├── diff.js            # computeToAdd: shared add-only diff (main + both CDN clients)
│   ├── cloudflare.js      # Cloudflare Lists client: cursor read, batched POST, MAX_ITEMS
│   ├── cdn_cdnfly.js      # cdnfly WAF openresty config client (read value, append, full PUT)
│   └── cdn_goedge.js      # GoEdge EdgeAdmin client: CSRF/login, export, multipart import
├── test_sync_blocklist.js # node:test; injected fetchImpl stubs
├── test_cdn_cdnfly.js     # node:test; injected fetchImpl stubs
├── test_cdn_goedge.js     # node:test; injected fetchImpl + clock (nowMs) stubs
├── ecosystem.config.cjs   # ALTERNATIVE pm2 app def; production schedules via a systemd timer
├── tsconfig.json          # strict checkJs config driving `npm run typecheck`
├── package.json           # scripts (sync/test/typecheck) + ipaddr.js dep
├── .env.example           # tracked config template; real .env is gitignored
└── README.md              # end-user docs (bilingual)
```

## WHERE TO LOOK
| Task | Location | Notes |
|---|---|---|
| Change what a run does | `src/main.js` → `main()` | Orchestrates CF then CDNs; exit code from here |
| Add/fix a feed parser rule | `src/ip.js` → `parseEntry` | ipaddr.js; strict four-part IPv4, Cloudflare prefix limits (/8-/32, /12-/128), canonical CIDR |
| Change the add-only diff | `src/diff.js` → `computeToAdd` | Shared by the Cloudflare sync and both CDN mirrors |
| Change Cloudflare IO | `src/cloudflare.js` | `fetchCfItems` (cursor pages), `addItemsToCf` (bare-array POST, waits for each bulk operation) |
| Change cdnfly behavior | `src/cdn_cdnfly.js` | Value is a JSON string with `custom_black` field |
| Change GoEdge behavior | `src/cdn_goedge.js` | Session + CSRF; see file header for live-verified API notes |
| Config keys / enable a CDN | `src/config.js` → `loadConfig`, `.env.example` | CDN enabled only when its `*_BASE_URL` is set |
| Scheduling / retry | systemd units on the host (`/etc/systemd/system/cf-blocklist-sync.{service,timer}`) | oneshot; `Restart=on-failure`, `RestartSec=5min`, 3 tries/hour; timer fires 12:00 Asia/Kuala_Lumpur |

## CODE MAP
| Symbol | Type | Location | Role |
|---|---|---|---|
| `main` | async fn | src/main.js | Full run; returns 0/1 |
| `syncCloudflare` | async fn | src/main.js | CF read + add-only delta; null when the list read fails |
| `syncCdnMirrors` | async fn | src/main.js | Push the reference set to the enabled CDN mirrors |
| `loadConfig` | fn | src/config.js | Parse `.env`, OS env overrides; throws on missing required keys |
| `ENV_FILE` | const | src/config.js | Default `.env` path — project root, i.e. `../.env` from `src/` |
| `parseEntry` | fn | src/ip.js | One feed line → canonical IP/CIDR or null |
| `parseStrictAddr` | fn (internal) | src/ip.js | Rejects IPv4 shorthand (`404`, hex, octal, leading zeros) and IPv6 zone IDs |
| `normalizeCfItem` | fn | src/ip.js | Normalize a stored item for diffing (unparsable kept raw) |
| `mergeFeeds` | fn | src/feed.js | Union of feed entry sets |
| `computeToAdd` | fn | src/diff.js | Add-only diff (reference minus existing), sorted |
| `fetchFeed` | async fn | src/feed.js | Fetch + parse one feed; errors → empty set |
| `fetchCfItems` | async fn | src/cloudflare.js | Paginate CF list; returns set or null (abort on null) |
| `addItemsToCf` | async fn | src/cloudflare.js | Batch POST missing items; true only if every bulk operation completed |
| `fetchCdnflyWafConfig` | async fn | src/cdn_cdnfly.js | Read + JSON-decode the openresty config value |
| `putCdnflyWafConfig` | async fn | src/cdn_cdnfly.js | Full-value PUT back |
| `cdnflyBlackSet` | fn | src/cdn_cdnfly.js | Normalized set of `custom_black` lines |
| `appendToCdnflyBlack` | fn | src/cdn_cdnfly.js | Append missing lines in place; returns count |
| `syncCdnfly` | async fn | src/cdn_cdnfly.js | Read → diff → append → PUT |
| `md5hex` | fn | src/cdn_goedge.js | MD5 hex of password (panel compares hash) |
| `parseXViewData` | fn | src/cdn_goedge.js | Extract `window.X_VIEW_DATA` login token from page shell |
| `goedgeLogin` | async fn | src/cdn_goedge.js | CSRF token → page token → login; captures Set-Cookie |
| `goedgeExportList` | async fn | src/cdn_goedge.js | Export one IP list → normalized set |
| `oneYearExpiry` | fn | src/cdn_goedge.js | Unix-seconds expiry one year from now |
| `syncGoedge` | async fn | src/cdn_goedge.js | Login, route v4/v6, batched import with re-export retry |
| `timedOut` | fn | src/http.js | Classifies AbortError/TimeoutError so callers log `timeout` |
| `trimTrailingSlash` | fn | src/http.js | Strip one trailing slash from a panel base URL |

## CONVENTIONS
- Every outbound HTTP call takes `fetchImpl = fetch` as an injectable param — tests depend on it; keep the parameter. It is last except in `syncGoedge`, where the optional `nowMs` clock follows it.
- Per-request timeouts via `AbortSignal.timeout`: 30 s reads (`FETCH_TIMEOUT_MS`), 60 s writes (`PUSH_TIMEOUT_MS`) — both defined once in `src/http.js`, which also owns `timedOut`.
- Batches of 500 everywhere: `CF_PAGE_SIZE`, `CF_BATCH_SIZE` (src/cloudflare.js), `IMPORT_BATCH` (src/cdn_goedge.js).
- Add-only invariant: nothing is ever deleted from any list; re-running is safe and idempotent.
- JSDoc `@typedef` / `@param` / `@returns` are load-bearing for the strict `checkJs` type check — keep them accurate.
- Logs use bracketed prefixes `[INFO]/[SUCCESS]/[WARN]/[ERROR]/[ABORT]/[DONE]/[FATAL]`.
- IO helpers return `null`/`false` on failure so the caller aborts instead of re-adding everything.
- Every IO entry point catches its own errors (including thrown timeouts) and degrades to a sentinel; `src/cdn_goedge.js` returns `{ok:false}` from `syncGoedge` rather than letting a timeout escape to `run_sync.js` as `[FATAL]`.

## ANTI-PATTERNS (THIS PROJECT)
- Do NOT add a top-level auto-run guard to `src/main.js`; `run_sync.js` is the entry point (importing `main.js` from tests must stay side-effect free).
- Do NOT hardcode the GoEdge session cookie name — it is build-specific; capture it from `Set-Cookie`.
- Do NOT rely on bare `node --test`: it discovers ZERO tests here (verified `pass 0`) because files are named `test_*.js`; use `npm test`, whose script globs `test_*.js`.
- Never commit `.env` (only `.env.example` is tracked).
- Never add delete/prune behavior — the add-only invariant is what makes re-runs safe.

## COMMANDS
```bash
npm install                 # deps (ipaddr.js)
npm run sync                # or: node run_sync.js — one-shot sync; writes the production Cloudflare blocklist, so run it only during a deliberate, intended sync
npm test                    # node --test "test_*.js"
npm run typecheck           # tsc --noEmit (strict checkJs over *.js/*.cjs)
systemctl enable --now cf-blocklist-sync.timer  # enable the daily run (units live in /etc/systemd/system on the host)
```
Exit-code contract: `0` = success (including "nothing to add"); `1` = at least one failure.

## NOTES
- CODE MAP omits line numbers deliberately — they rot on every edit; grep the symbol name instead.
- `tsconfig.json` checks root `*.js`/`*.cjs` plus `src/**/*.js`, and deliberately excludes `test_*.js`. A new source directory must be added to `include` or it is silently not typechecked.
- Production runs via a systemd oneshot service: `Restart=on-failure`, `RestartSec=5min`, 3 tries within 1 hour, then it waits for the next timer tick; logs to `/var/log/cf_sync.log` (stderr `/var/log/cf_sync.err`). `ecosystem.config.cjs` is a pm2 alternative, unused on this host.
- The cdnfly and GoEdge mirrors are enabled only when `CDNFLY_BASE_URL` / `GOEDGE_BASE_URL` is set; otherwise the step is skipped with an `[INFO]` log.
- Cloudflare list capacity is 10,000 (`MAX_ITEMS`); exceeding it only logs a `[WARN]` and continues.
- `.env` is read from the project root; OS environment variables override file values. `src/config.js` derives that path from its own location (`../.env`), so moving it without adjusting `ENV_FILE` aims config at `src/.env` — production fails while the other `loadConfig` tests (which all pass explicit paths) stay green. Only the `ENV_FILE` test guards it.

---

# Agent workflow (four beats)

The four beats (isolate → build → prove → ship) — with their companion skills, the multi-agent rules, and the public-comment attribution conventions — are adapted from the michaelshimeles/skills AGENTS.md (commit 4b72f46). This repo's own additions are the two sections below.

- **Isolate** — start each change in its own branch off `origin/main`, never directly on `main`.
- **Build** — write the change to the repo's architecture and conventions.
- **Prove** — run the repo's checks (below) and keep the evidence that the change works.
- **Ship** — open the PR with that evidence in the description.

Checks for this repo: the `npm test` and `npm run typecheck` entries in the COMMANDS block above.

Hard invariants:

- `npm run sync` writes the production Cloudflare blocklist, so run it only during a deliberate, intended sync. On the production host a systemd timer runs this same checkout — the checkout IS the deployed code.
- `test_cdn_cdnfly.js` and `test_cdn_goedge.js` are unit tests: they use injected `fetchImpl` stubs and fake hosts (`http://cdn.example`, `http://edge.example`), run as part of `npm test`, and are safe to run locally.
