# cf-blocklist-sync

A Node.js batch CLI that keeps IP blocklists in sync across four systems: two text-based IP blocklist feeds, a Cloudflare List, and two CDN admin panels. On every run it fetches the IPv4 and IPv6 feeds, parses and dedupes the entries, adds whatever is missing to the Cloudflare List, then mirrors the resulting reference set to a cdnfly-class panel (via its WAF openresty config) and to GoEdge/EdgeAdmin panels. The sync is add-only and idempotent, and it is scheduled daily with pm2.

```
IPv4 feed ─┐
           ├─> parse + dedupe (ipaddr.js) ─> diff vs Cloudflare list ─> add missing (POST, batches of 500)
IPv6 feed ─┘                                                          │
                                                                      │ reference set (add-only diff)
                                             ┌────────────────────────┴────────────────────┐
                                             ▼                                            ▼
                               cdnfly panel: append to              GoEdge panels: import to v4/v6
                               WAF custom_black (read + PUT)        IP lists (batches of 500,
                                                                   re-export + re-diff on failure)
```

## 中文摘要

- 从两条 IP 黑名单订阅源（IPv4 / IPv6）拉取数据，经解析、去重与校验后增量添加到 Cloudflare List，并把结果同步到 cdnfly 与 GoEdge 两个 CDN 面板。
- 只增不删、可重复执行：Cloudflare 与两个 CDN 面板均只做增量添加，重复运行是安全的。
- 通过 pm2 定时任务每天 12:00 本地时间自动运行，日志写入 /var/log/cf_sync.log。
- `npm test` 运行全部测试（网络调用均已 mock，不触碰线上端点）。

## What it does

This tool consumes two plain-text feed URLs (one for IPv4, one for IPv6) from its `.env` configuration. It parses and normalizes each entry (bare IPs and CIDR ranges) with `ipaddr.js`, dropping malformed entries and removing duplicates. It then reads the current Cloudflare List (paginated read) and computes an add-only diff, POSTing any missing entries in batches of 500. The resulting reference set is mirrored to a cdnfly-class panel by reading and PUTting the WAF openresty config's `custom_black` field, and to GoEdge/EdgeAdmin v1.x panels via session login with CSRF handling: each IP list is exported, and the new entries are imported in batches of 500 with re-export + re-diff retry if a batch fails. It never deletes entries from any system, so it is safe to run repeatedly.

## Requirements

- Node.js >= 20 (built and tested on Node 26)
- npm

## Install

```bash
npm install
```

## Configuration

Copy the example environment file and restrict its permissions:

```bash
cp .env.example .env
chmod 600 .env
```

Then fill in the values in `.env`. **Never commit `.env`** — it is the only secrets file, and `.gitignore` already excludes `.env` and `.env.*` (while keeping `.env.example` tracked). OS environment variables override values from `.env`.

| Variable | Required | Description |
| --- | --- | --- |
| `CF_AUTH_TOKEN` | yes | Cloudflare API token (List read/write) |
| `CF_ACCOUNT_ID` | yes | Cloudflare account ID |
| `CF_LIST_ID` | yes | Cloudflare List ID to sync into |
| `URL_IPV4` | yes | IPv4 feed URL (includes any secret query parameters) |
| `URL_IPV6` | yes | IPv6 feed URL (includes any secret query parameters) |
| `CDNFLY_BASE_URL` | optional | cdnfly panel base URL; omit to disable the cdnfly mirror |
| `CDNFLY_API_KEY` | optional | cdnfly panel API key |
| `CDNFLY_API_SECRET` | optional | cdnfly panel API secret |
| `CDNFLY_WAF_CONFIG_ID` | optional | cdnfly WAF openresty config ID to update |
| `GOEDGE_BASE_URL` | optional | GoEdge EdgeAdmin base URL; omit to disable the GoEdge mirror |
| `GOEDGE_USERNAME` | optional | GoEdge EdgeAdmin login username |
| `GOEDGE_PASSWORD` | optional | GoEdge EdgeAdmin login password |
| `GOEDGE_V4_LIST_ID` | optional | GoEdge IPv4 IP list ID to import into |
| `GOEDGE_V6_LIST_ID` | optional | GoEdge IPv6 IP list ID to import into |

## Usage

```bash
node run_sync.js
# or
npm run sync
```

Exit code `0` means success (including the "nothing to add" case); exit code `1` means at least one failure. The sync is add-only: re-running it is safe and idempotent — a second consecutive run adds 0 entries.

## Deploy

```bash
pm2 start ecosystem.config.cjs && pm2 save
```

The pm2 ecosystem runs the sync daily at 12:00 local time (cron `0 12 * * *`) and writes logs to `/var/log/cf_sync.log`. It is a one-shot app: a clean exit stops the process until the next cron tick, while a failed run retries after a short delay.

## Testing

```bash
npm test
```

Runs the test suite with Node's built-in `node:test` runner (3 test files). All network calls are mocked or overridden, so no live endpoints are touched.

## Design notes

- **Add-only everywhere**: the Cloudflare list and both CDN panels only ever gain entries; nothing is deleted, so the pipeline is safe to run repeatedly.
- **Idempotent**: a run with nothing new to add exits 0 and changes nothing.
- **Cloudflare**: missing entries are POSTed in batches of 500.
- **GoEdge**: entries are imported in batches of 500; if a batch fails, the list is re-exported and re-diffed so only the truly missing entries are retried.
- **Timeouts**: every outbound request uses per-request timeouts via `AbortSignal.timeout` (30 s for reads, 60 s for writes).
- **Config**: loaded from `.env` with OS environment override; a missing required key aborts the run with exit 1.
