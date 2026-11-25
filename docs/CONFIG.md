# Configuration reference

Every environment variable the non-test code reads, with where it is read. Names and code
defaults only; no values from any deployment. The two `.env.example` files show the
expected shape (see the [README](../README.md#quick-start)); where they and this page differ,
the code is the reference.

- **Required** means the process refuses to start without it. Everything else has a
  default in code or is off when unset.
- **Secret** means the value grants access and must not be printed or committed. "Public"
  means the value is not a credential (it may still be operator-specific, such as an
  account address).
- An empty default means "unset": the feature it controls is off, or the list is empty.

## Server (`server/`, the agent and API)

All `server/src/config.ts` values are read once, on first access, and validated there
(`config.ts:1-2`, `:254-260`). `server/src/index.ts:18` forces that read at startup, so a
missing required value or a value that fails validation stops the process.

| Name | Read at | Required | Default in code | Class | Notes |
|---|---|---|---|---|---|
| `API_AUTH_TOKEN` | `server/src/config.ts:125` | **required** | none | **secret** | Operator Bearer token. The only required value. |
| `RADIX_NETWORK_ID` | `server/src/config.ts:83` | optional | `1` | public | `1` mainnet, `2` stokenet. |
| `GATEWAY_URL` | `server/src/config.ts:84` | optional | `https://mainnet.radixdlt.com` | public | |
| `MAX_GAS_XRD` | `server/src/config.ts:92`, `:240` | optional | `10` | public | Decimal `>= 1`, no scientific notation; otherwise startup fails (`:242-246`). |
| `SCAN_INTERVAL_MS` | `server/src/config.ts:95` | optional | `60000` | public | |
| `SNAPSHOT_INTERVAL_MS` | `server/src/config.ts:102` | optional | `3600000` | public | Non-negative integer (`:227-231`). |
| `SNAPSHOT_RETENTION_DAYS` | `server/src/config.ts:105` | optional | `30` | public | Integer from 30 to 3650 (`:218-226`). |
| `MIN_REBALANCE_DIFF_BPS` | `server/src/config.ts:106` | optional | `200` | public | |
| `MAX_SLIPPAGE_BPS` | `server/src/config.ts:107` | optional | `50` | public | Positive integer (`:208-212`). |
| `ROTATION_REVIEW_INTERVAL_MS` | `server/src/config.ts:110` | optional | `604800000` | public | 7 days. |
| `ROTATION_COOLDOWN_MS` | `server/src/config.ts:111` | optional | `259200000` | public | 3 days. |
| `AUTO_EXECUTE_THRESHOLD_XRD` | `server/src/config.ts:114` | optional | `5000` | public | Display flag only; nothing executes (`:112-113`). |
| `APY_DROP_EXIT_PCT` | `server/src/config.ts:117` | optional | `30` | public | |
| `TVL_DROP_EXIT_PCT` | `server/src/config.ts:118` | optional | `40` | public | |
| `API_PORT` | `server/src/config.ts:121` | optional | `3001` | public | |
| `API_HOST` | `server/src/config.ts:124` | optional | `127.0.0.1` | public | Bind address (`api.ts:767`). |
| `OPERATOR_ADDRESSES` | `server/src/config.ts:134` | optional | empty | public | Comma-separated accounts whose ROLA session counts as operator. Empty = no session is operator. |
| `WATCH_ADDRESSES` | `server/src/config.ts:142` | optional | empty | public | Comma-separated accounts for the operator watch list. |
| `CORS_ORIGIN` | `server/src/config.ts:146` | optional | `http://localhost:5173` | public | |
| `TRUST_PROXY` | `server/src/config.ts:150` | optional | `false` | public | `true` only behind a reverse proxy. |
| `DAPP_DEFINITION_ADDRESS` | `server/src/config.ts:159-162` | optional | the address in code (ends `…wfek704t`) | public | Must match the frontend and `frontend/public/.well-known/radix.json`. |
| `ROLA_EXPECTED_ORIGIN` | `server/src/config.ts:163` | optional | `http://localhost:3000` | public | Must equal the dapp's origin. |
| `SESSION_COOKIE_SECURE` | `server/src/config.ts:165` | optional | `false` | public | `true` behind HTTPS. |
| `RATE_LIMIT_POST_PER_MIN` | `server/src/config.ts:168` | optional | `10` | public | |
| `RATE_LIMIT_GET_PER_MIN` | `server/src/config.ts:169` | optional | `60` | public | |
| `CIRCUIT_BREAKER_THRESHOLD` | `server/src/config.ts:172` | optional | `5` | public | |
| `CIRCUIT_BREAKER_WINDOW_MS` | `server/src/config.ts:173` | optional | `600000` | public | |
| `DB_PATH` | `server/src/config.ts:176` | optional | `./data/defi-farmer.db` | public | SQLite file, relative to the process working directory. |
| `MIN_TVL_THRESHOLD` | `server/src/config.ts:179` | optional | `1000000` | public | USD. |
| `MIN_POOL_TVL_USD` | `server/src/config.ts:193` | optional | `1000` | public | Dust floor for the ranked index. |
| `PLATFORM_FEE_RATE` | `server/src/config.ts:199` | optional | empty (off) | public | See [MONETIZATION](MONETIZATION.md). |
| `PLATFORM_FEE_COMPONENT` | `server/src/config.ts:200` | optional | empty (off) | public | See [MONETIZATION](MONETIZATION.md). |
| `DEX_PACKAGES_OCISWAP_BASIC` | `server/src/config.ts:40`, read via `:203` | optional | empty | public | Extra pinned pool packages, comma-separated `package_rdx1…`. A malformed entry stops startup (`:71-73`). Values recorded in [DEX-INTEGRATION](DEX-INTEGRATION.md#do-not-trust-the-scanner-registry--resolve-blueprint-per-component-at-runtime). |
| `DEX_PACKAGES_OCISWAP_PRECISION` | `server/src/config.ts:41`, read via `:203` | optional | empty | public | As above. One Precision package is also pinned in code. |
| `DEX_PACKAGES_CAVIARNINE_WEIGHTED` | `server/src/config.ts:42`, read via `:203` | optional | empty | public | As above. |
| `DEX_PACKAGES_CAVIARNINE_QUANTASWAP` | `server/src/config.ts:43`, read via `:203` | optional | empty | public | As above. One QuantaSwap package is also pinned in code. |
| `DEX_PACKAGES_DEFIPLAZA_PAIR` | `server/src/config.ts:44`, read via `:203` | optional | empty | public | As above. |
| `DEX_DEPOSITS_DISABLED_KINDS` | `server/src/config.ts:54`, read at `server/src/services/dex/deposit-switch.ts:70` | optional | empty (nothing paused) | public | Kind names from `DEX_PACKAGE_ENV`. A bad value refuses all pool deposits; exits keep working. See [Pausing deposits](DEX-INTEGRATION.md#pausing-deposits-operator-switch). |
| `DEX_DEPOSITS_DENY_POOLS` | `server/src/config.ts:56`, read at `server/src/services/dex/deposit-switch.ts:70` | optional | empty (nothing paused) | public | Pool `component_rdx1…` addresses. Same failure behaviour. |
| `CRASH_LOG_DIR` | `server/src/crash-guard.ts:18` | optional | `./logs` | public | Crash log directory, relative to the working directory. |
| `CRASH_LOG_MAX_MB` | `server/src/crash-guard.ts:19` | optional | `10` | public | Crash log size before rotation. |

Without any `DEX_PACKAGES_*` line, only the two package pins in code are accepted, and pools
on every other package resolve as unsupported
([DEX-INTEGRATION](DEX-INTEGRATION.md#do-not-trust-the-scanner-registry--resolve-blueprint-per-component-at-runtime),
`config.ts:32-38`).

## Frontend (`frontend/`, the Next.js dapp)

`NEXT_PUBLIC_*` values are inlined into the browser bundle at build time
(`frontend/lib/gift/index.ts:46-49`), so they must be set before `next build`, and changing
one requires a rebuild. The other names are read by the Next server process at runtime.

| Name | Read at | Required | Default in code | Class | Notes |
|---|---|---|---|---|---|
| `BACKEND_API_URL` | `frontend/app/api/[...path]/route.ts:40` | optional | `http://localhost:3001` | public | Server-side only; do not prefix with `NEXT_PUBLIC_` (`next.config.js:10-11`). In production it must be https to a non-private host, or loopback (http or https) with `ALLOW_LOOPBACK_BACKEND=true` (`frontend/lib/server/proxy-guard.ts:63-92`); otherwise every `/api/*` call answers 503 (`route.ts:55-58`). |
| `ALLOW_LOOPBACK_BACKEND` | `frontend/lib/server/proxy-guard.ts:79` | optional | unset (false) | public | `true` when the API runs on the same machine. |
| `ALLOWED_ORIGINS` | `frontend/lib/server/proxy-guard.ts:134` | optional | empty (same-origin only) | public | Comma-separated extra origins allowed to make state-changing calls. |
| `NEXT_PUBLIC_RADIX_NETWORK_ID` | `frontend/lib/radix-provider.tsx:63` | optional | `1` | public | Build-time. |
| `NEXT_PUBLIC_DAPP_DEFINITION_ADDRESS` | `frontend/lib/radix-provider.tsx:69` | optional | the address in code (ends `…wfek704t`) | public | Build-time. Must match the server's `DAPP_DEFINITION_ADDRESS`. |
| `NEXT_PUBLIC_GIFT_XRD_ADDRESS` | `frontend/lib/gift/index.ts:52` | optional | empty (rail dark) | public | Build-time. Validated by `frontend/lib/gift`. |
| `NEXT_PUBLIC_GIFT_BTC_ADDRESS` | `frontend/lib/gift/index.ts:53` | optional | empty (rail dark) | public | Build-time. Validated by `frontend/lib/gift`. |
| `NEXT_PUBLIC_USE_MOCKS` | `frontend/lib/hooks/use-fetch.ts:27` | optional | off | public | `true` shows sample data; sign actions are disabled. Development only. |
| `NODE_ENV` | `frontend/next.config.js:32`, `frontend/lib/server/proxy-guard.ts:56`, `:115` | optional | not set by this code | public | `production` turns on HSTS, drops `'unsafe-eval'`, enforces the backend URL rules and refuses state-changing calls with no `Origin`. |

## Not listed

- Names read only under `server/tests/` or `frontend/tests/` (the test setup sets its own
  values, `server/tests/setup.ts`).
- Names used only inside `.github/workflows/` (`GITLEAKS_VERSION`, `GITLEAKS_SHA256` are set
  in `secret-scan.yml:43,47`). The workflows contain no `secrets.` reference.
