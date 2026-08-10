# BS#2076 — Enable gzip response compression at the nginx edge (api.wxyc.org)

Tracking issue: [WXYC/Backend-Service#2076](https://github.com/WXYC/Backend-Service/issues/2076).

No layer of the production stack compresses responses today. Every JSON body — including the iOS app's 91 KB `/library/rotation` and 57 KB `/concerts` payloads — crosses the wire uncompressed. Enabling gzip on the `api.wxyc.org` server block cuts measured payloads by 4.2–5.3x with no client-side change anywhere.

## Evidence (measured 2026-08-09)

**Nothing is compressed.** A `GET https://api.wxyc.org/flowsheet` sent with `Accept-Encoding: gzip, deflate, br` returns `Content-Length: 26811` and **no** `Content-Encoding` header. On the box, `sudo nginx -T` shows the active config is a single hand-edited `/etc/nginx/nginx.conf` (173 lines, TLS stanzas managed by Certbot, `sites-enabled/` empty) containing **zero gzip directives** — the only `gzip` match anywhere under `/etc/nginx` is a commented `#gzip  on;` in the untouched `nginx.conf.default`. On the app side, `compression` is not a dependency of `apps/backend` and `apps/backend/app.ts` mounts no compression middleware.

This is a silent default, not a decision: `gzip on` alone leaves `gzip_types` at its default of `text/html` only, so even a half-configured nginx would not have compressed `application/json`.

**Egress profile.** A full day of `/var/log/nginx/access.log-20260809` (Aug 8 UTC): 23,251 requests, 268.8 MiB. **All byte figures in this plan are MiB** (`bytes / 1048576`); an earlier draft mixed decimal MB into some tables and it made them appear not to reconcile.

Read that log carefully — there is **no `access_log` or `log_format` directive anywhere in the config**, so all three vhosts write to one default log with no vhost field. Raw totals are _not_ Backend-Service totals. Attributing by request path (all figures MiB, `bytes / 1048576`):

| Bucket                                                                             |     Bytes/day | Requests | In scope?                       |
| ---------------------------------------------------------------------------------- | ------------: | -------: | ------------------------------- |
| Backend routes on `:8080` (flowsheet, library, playlists, concerts, proxy, djs, …) | **221.6 MiB** |   13,447 | yes                             |
| `/events/*` SSE                                                                    |      18.4 MiB |      908 | no — deliberately excluded      |
| Other vhosts + scanner noise                                                       |      27.4 MiB |    3,561 | no — `explore` / `wiki`         |
| `/auth/*` → `:8082`                                                                |       1.4 MiB |    5,335 | no — excluded, see BREACH below |

Top Backend paths by total bytes:

| Path                                                         |     Bytes/day | Requests | Avg/response |
| ------------------------------------------------------------ | ------------: | -------: | -----------: |
| `/playlists/recentEntries`                                   |      59.1 MiB |    6,017 |      10.3 KB |
| `/library/rotation`                                          |      50.7 MiB |      582 |      91.4 KB |
| `/concerts`                                                  |      39.0 MiB |      715 |      57.2 KB |
| `/flowsheet`                                                 |      35.4 MiB |    1,277 |      29.1 KB |
| `/library/`                                                  |      23.6 MiB |      691 |      35.8 KB |
| `/flowsheet/`                                                |      12.5 MiB |    1,354 |       9.7 KB |
| _(long tail: `/proxy/*`, `/flowsheet/latest`, `/config`, …)_ |       1.2 MiB |        — |            — |
| **Total**                                                    | **221.6 MiB** |          |              |

These are **exact paths**, not prefix buckets — the aggregation splits on `?` and groups on the literal path, so `/library/rotation` and `/library/` are distinct rows and nothing is double-counted. (An earlier draft of this table appeared not to reconcile against the 221.6 MiB bucket; that was a unit error — decimal `MB` in one table against `MiB` in the other — now corrected to MiB throughout.)

**Compression ratios on real captured bodies** (`gzip -6`): `/flowsheet` 26,811 → 6,400 B (**4.2x**, 76% off); `/playlists/recentEntries` 49,962 → 9,378 B (**5.3x**, 81% off). Brotli-5 on the flowsheet body is 5,949 B — ~7% better than gzip, not worth the extra module and build step here.

**How much of that bucket clears `gzip_min_length 1024`?** Measured directly: **221.4 MiB across 6,775 responses** are ≥ 1024 bytes; the other 6,672 responses — literally half the request count — carry just **0.1 MiB** between them. The threshold therefore forfeits 0.05% of the available bytes while skipping half the compression calls, which is exactly the trade it exists to make.

So the compressible target is **221.4 MiB/day**. At the measured ratios that lands near 45 MiB, saving **~175 MiB/day (~5.1 GiB/month)**.

One code-level caveat on that base: `apps/backend/controllers/proxy.controller.ts:199,256` serves artwork with a dynamic `image/*` content type. Image bytes are inside the Backend bucket but are excluded from compression by construction (`image/*` is absent from `gzip_types`) and would compress poorly anyway. On the measured day this is moot — the artwork route drew **zero** traffic, and all ~600 KB of `/proxy/*` was JSON — but a future spike in artwork proxying would pass through uncompressed rather than inflate.

## Why do this — and why _not_ on cost grounds

5.1 GiB/month of EC2 egress is roughly **$0.46/month**. Anyone evaluating this as a cost measure should reject it.

The case is **latency on constrained clients**. `/library/rotation` at 91.4 KB and `/concerts` at 57.2 KB are wxyc-ios-64 payloads; on cellular, a 4–5x size cut is a directly perceptible improvement in time-to-content. `/playlists/recentEntries` at 6,017 requests/day is the highest-frequency read on the service. The change is also unusually cheap and unusually reversible, which is most of its appeal.

## Chosen layer: nginx, not Express middleware

Both layers were scoped. **nginx wins on the SSE hazard.**

`apps/backend/utils/serverEvents.ts` writes SSE frames with bare `res.write` (`:94`, `:155`, `:261`, `:292`) and **never calls `res.flush()`**, and sets `Content-Type: text/event-stream` (`:141`). The npm `compression` middleware's default filter delegates to the `compressible` module — verified directly, not assumed:

```
$ node -e "console.log(require('compressible')('text/event-stream'))"
true
```

Mounted globally with defaults it would buffer SSE frames inside zlib and silently wedge `/events/stream` — 908 connections/day. That is an opt-_out_ you must remember.

The mechanism that makes SSE work today is worth naming, because it also determines which guard protects it: `serverEvents.ts:146` sets `'X-Accel-Buffering': 'no'` (its own comment reads _"Header that makes nginx behave with sse"_). That is why SSE streams correctly through `location /` despite `proxy_buffering` being at its default of on — and it means the SSE response is unbuffered with **no upstream `Content-Length`**, so `gzip_min_length` cannot gate it either. `gzip_types` omitting `text/event-stream` is therefore the _sole_ guard on that path, not one of two. Do not treat the `gzip_min_length` line as a backstop for it.

nginx's `gzip_types` is an opt-_in_ allowlist. Omitting `text/event-stream` excludes SSE by construction, and no application code changes at all.

Secondary points that also favour nginx, none decisive on its own:

- The Express path would have to interleave with `singleValidatorCache` (`apps/backend/middleware/conditionalGet.ts:82`), which overrides `res.end` to strip the BS#1689 sentinel ETag. `compression` overrides `res.write`/`res.end` too. Global mounting happens to nest correctly, but it is order-dependent and would need a dedicated regression test.
- No Node CPU or heap cost on a t3.small (2 vCPU, 1.9 GB, 826 MB available, load average 0.42 at time of survey).

The one genuine advantage the Express path holds — that it lives in the repo and ships through CI — is real, and is addressed as a follow-up rather than ignored (see **Known gap**).

## The change

Insert six directives into the `api.wxyc.org` `server { }` block in `/etc/nginx/nginx.conf` (the block opening at line 10, alongside the existing `proxy_set_header` lines at 19–22), plus a one-line opt-out on the existing `/auth/` location:

```nginx
gzip              on;
gzip_vary         on;
gzip_proxied      any;
gzip_comp_level   5;
gzip_min_length   1024;
gzip_types        application/json application/javascript text/javascript text/css text/plain;
```

```nginx
location /auth/healthcheck {
    gzip off;                      # sibling location — does NOT inherit from /auth/
    proxy_pass http://localhost:8082/healthcheck;
}

location /auth/ {
    gzip off;                      # BREACH-class exposure; see below
    proxy_pass http://localhost:8082/auth/;
}
```

**Both** auth locations need the directive. nginx `location` blocks do not inherit from a sibling whose prefix happens to be shorter — they inherit from the enclosing `server`/`http` scope — and the config already carries a dedicated `location /auth/healthcheck` (nginx.conf line 44) alongside `location /auth/` (line 48). Putting `gzip off` only on the latter would leave `/auth/healthcheck` running under the server-level `gzip on`. Nothing is actually at risk there (a 45-byte healthcheck body carries no secret and sits under `gzip_min_length` regardless), but the asymmetry is a footgun for whoever adds the next `location /auth/…`.

Directive-by-directive rationale:

- **`gzip_types` deliberately omits `text/html` and `text/event-stream`.** `text/html` is always compressed by nginx and cannot be removed from the list; `text/event-stream` is excluded on purpose — this is the SSE guard, and it is the load-bearing line in this block.
- **Both `application/javascript` and `text/javascript` are listed**, because only the second one actually matches today. `apps/backend/app.ts:91` mounts `swagger-ui-express`, whose 1.5 MB `swagger-ui-bundle.js` goes out through `express.static` → `send@1.2.1` → its **nested** `mime-types@3.0.2`, which resolves `.js` to `text/javascript`. (The hoisted root `mime-types@2.1.35` still says `application/javascript` — checking that one instead is how this was nearly missed.) Listing only `application/javascript` would silently exclude the single largest compressible asset on the host.
- **`gzip off` on `/auth/`** is a security decision that costs essentially nothing. Those responses carry session tokens and JWTs; compressing a response that contains a secret alongside any attacker-influenced input is the BREACH precondition, and a compression oracle over auth responses is not a risk worth taking to save bytes. And there are no bytes to save: `/auth/*` moved 1.4 MiB over 5,335 requests on the measured day — a **262-byte average**, almost entirely beneath `gzip_min_length` already. Making the exclusion explicit costs ~0.6% of the projected win and removes the question permanently. The main API surface is not in the same position: `/flowsheet`, `/library`, `/concerts` and friends return no session material, so they carry no equivalent exposure.
- **`gzip_min_length 1024`** is not cosmetic. Measured: a 55-byte 401 body _grows_ to 97 bytes under gzip. `/flowsheet/on-air` returns 17 bytes and `/flowsheet/djs-on-air` 35 bytes. Half of all in-scope requests (6,672 of 13,447) fall below this line while carrying only 0.1 MiB between them. The threshold is evaluated against the upstream `Content-Length`, which nginx has for ordinary buffered proxy responses — but **not** for a response the upstream marks `X-Accel-Buffering: no`, which is why it is no help at all on the SSE path (above).
- **`gzip_comp_level 5`**, not 9. Measured delta from 6→9 on the flowsheet body is 6,400 → 6,316 B (1.3%) for materially more CPU. On a burstable t3 instance, spending CPU credits for 1% is the wrong trade.
- **`gzip_vary on`** emits `Vary: Accept-Encoding`, required for correctness at any downstream cache. The api block already emits `Vary: Origin` from the CORS middleware; nginx appends rather than replaces, and both are spec-valid.
- **`gzip_proxied any`** is belt-and-braces. The directive gates on a `Via` header in the _client request_ (not on nginx being a reverse proxy), and our clients send none, so the default `off` would not actually block compression — but stating it removes a subtle trap for the next reader.

**Placement is scoped to the api server block on purpose.** Hoisting these into `http { }` would also compress `explore.wxyc.org` (semantic-index, `localhost:8083`) and `wiki.wxyc.org` (Wiki.js, `127.0.0.1:3000`), which share this nginx. Those are other repos' surfaces with other owners; picking up their egress win is a real opportunity but not Backend-Service's call to make unilaterally. Deferred to a follow-up after this soaks.

## Why this is low-risk

**Compression is client-negotiated.** A client that does not send `Accept-Encoding: gzip` receives byte-identical responses to today. URLSession, browsers, and Node's fetch/undici all advertise and transparently decode gzip. No change is required in wxyc-ios-64, dj-site, WXYC-Android, wxyc-canary, or auto-dj-orchestrator, and no `wxyc-shared` / `api.yaml` change is involved — this alters transfer encoding, never the wire shape.

Paths verified as unaffected:

- **`/events/stream` (SSE)** — `text/event-stream` is absent from `gzip_types`.
- **`/cdc` (WebSocket)** — its own `location` block with `Upgrade`/`Connection "upgrade"`; nginx does not gzip a 101 response.
- **Conditional GET 304s** — `conditionalGet` replies `res.status(304).end()` with no body; nothing to compress.
- **BS#1689 `singleValidatorCache`** — sets `Cache-Control: no-cache` and strips the sentinel ETag. No interaction with transfer encoding, and with `Vary: Accept-Encoding` present there is no cache-variant hazard.

One forward-looking interaction: **BS#2061** (`feat/2061-public-cors`, in flight) widens CORS to public origins, and its `cors.ts` notes that `Vary: Origin` is already on every response and stays. Once both land, responses vary on **both** `Origin` and `Accept-Encoding`, fragmenting the cache key for any shared cache further. Not a correctness problem — both headers are required for correctness — but the two changes should not be soaked simultaneously if egress numbers are being read as the verification signal, since each moves them.

## Apply procedure

1. `sudo cp /etc/nginx/nginx.conf /etc/nginx/nginx.conf.bak-$(date +%Y%m%d)` — the config is not in version control, so the backup _is_ the rollback.
2. Insert the six directives into the `api.wxyc.org` server block.
3. `sudo nginx -t` — **must pass before proceeding.** A syntax error takes down api, explore, and wiki together.
4. `sudo systemctl reload nginx` — graceful; in-flight connections are not dropped.

Rollback is: restore the `.bak`, `sudo nginx -t`, reload.

### Applied — 2026-08-09, 17:59 PDT

Live on the box. Backup at `/etc/nginx/nginx.conf.bak-20260810` (name carries the box's UTC date), md5-verified identical to the pre-change config before editing. The edit was made by an assertion-guarded script that refused to run unless lines 17/22/43/47 matched the survey exactly, the file contained no pre-existing `gzip` token, and the two `server_name api.wxyc.org` blocks sat at exactly lines 17 and 73 — the second is the port-80 Certbot redirect and must not be touched. Resulting diff was 14 added lines, all inside the 443 block. `nginx -t` passed; `systemctl reload nginx` kept main PID 1561, so no connection was dropped.

All acceptance criteria pass. Measured on `/playlists/recentEntries`: **50,697 → 9,128 bytes on the wire (5.6x, 82% off)**, decoded body `cmp`-identical. SSE returned `text/event-stream` with no `Content-Encoding` and frames arriving live. `/flowsheet/on-air` (17 B) and `/flowsheet/djs-on-air` (34 B) stayed uncompressed. Conditional GET still 304s on `/flowsheet` and `/flowsheet/latest`, including with `Accept-Encoding: gzip` negotiated. `nginx -T | grep -c 'gzip off'` returned 2.

Two things the run corrected in this document, both in Verification above: `/concerts` is 401-gated anonymously (55-byte body, never reaches `gzip_min_length`) so it cannot serve as the byte-identical fixture; and curl's `%{size_download}` reports wire bytes even under `--compressed`, so the original step 3 printed the same number twice and proved nothing.

Two pre-existing conditions observed and ruled out as unrelated — neither block was touched: `wiki.wxyc.org` returns 502 because nothing is listening on `127.0.0.1:3000`, and `/cdc` returns 403 from the application after nginx proxies the upgrade correctly.

Still outstanding from this plan: the `docs/deploy.md` subsection + `@rule` marker, the `serverEvents.ts:146` comment, and the `CLAUDE.md:14` amendment. Those are repo changes and want a worktree.

## Verification

```bash
# 1. JSON is compressed, and advertises the variant
curl -s -D - -o /dev/null -H 'Accept-Encoding: gzip' https://api.wxyc.org/flowsheet \
  | grep -iE 'content-encoding|vary'          # expect: Content-Encoding: gzip + Vary: Accept-Encoding

# 2. Decoded body is byte-identical to the uncompressed body — the actual AC-1 test.
#    NOT /flowsheet: it mutates between the two calls and produces spurious diffs.
#    NOT /concerts either — it is 401-gated without an Authorization header (bytes=55),
#    so it can never exercise gzip_min_length. /playlists/recentEntries is public,
#    ~50 KB, and stable enough between two back-to-back calls.
#    Comparing sizes alone cannot detect a corrupt decode; this is the real check.
curl -s --compressed          https://api.wxyc.org/playlists/recentEntries -o /tmp/gz.json
curl -s -H 'Accept-Encoding:' https://api.wxyc.org/playlists/recentEntries -o /tmp/raw.json
cmp /tmp/gz.json /tmp/raw.json && echo "IDENTICAL ($(wc -c < /tmp/raw.json) bytes)"

# 3. And the compression is real. NOTE: curl's %{size_download} reports WIRE bytes
#    even under --compressed, so printing it twice yields the same number and proves
#    nothing. Compare the wire size against the decoded size from step 2 instead.
curl -s -o /dev/null -w 'wire=%{size_download}\n' -H 'Accept-Encoding: gzip' https://api.wxyc.org/playlists/recentEntries
wc -c < /tmp/raw.json    # decoded, from step 2

# 4. SSE is NOT compressed — the critical check
curl -s -D - -N -m 5 -H 'Accept-Encoding: gzip' https://api.wxyc.org/events/stream | head -20
#    expect Content-Type: text/event-stream, NO Content-Encoding, frames arriving live

# 5. Sub-threshold bodies are left alone
curl -s -D - -o /dev/null -H 'Accept-Encoding: gzip' https://api.wxyc.org/flowsheet/on-air | grep -i content-encoding  # expect no match

# 6. Conditional GET still 304s
curl -s -o /dev/null -w '%{http_code}\n' -H 'If-Modified-Since: Wed, 01 Jan 2031 00:00:00 GMT' https://api.wxyc.org/flowsheet  # expect 304
```

```bash
# 6b. Same conditional-GET check on the sibling route named in AC 5
curl -s -o /dev/null -w '%{http_code}\n' -H 'If-Modified-Since: Wed, 01 Jan 2031 00:00:00 GMT' https://api.wxyc.org/flowsheet/latest  # expect 304

# 7. The /auth/ opt-out took. Assert the DIRECTIVE, not the behaviour: /auth/*
#    averages 262 bytes, so gzip_min_length already suppresses compression there
#    and "no Content-Encoding" would be observed whether or not `gzip off` applied.
#    A behavioural check here cannot fail and therefore proves nothing.
sudo nginx -T | sed -n '/location \/auth\//,/}/p' | grep -c 'gzip off'   # expect 2 (both auth locations)
```

Then confirm the WebSocket path: open dj.wxyc.org and check the `/cdc` connection establishes and live flowsheet updates still arrive.

**Longitudinal check.** nginx logs `$body_bytes_sent`, so the access log measures the post-compression size and doubles as a free before/after signal. Baseline to beat, from Aug 8: **268.8 MiB / 23,251 requests total**, of which **221.4 MiB is the compressible in-scope portion** (the ≥1024-byte slice of the 221.6 MiB Backend bucket). Twenty-four hours after the reload, re-run:

```bash
sudo awk '{n++; b+=$10} END {printf "requests=%d bytes=%d MiB=%.1f\n", n, b, b/1048576}' /var/log/nginx/access.log-<date>
```

Expect roughly **90–110 MiB** at comparable request volume — not lower, because ~47 MiB/day (18.4 SSE + 27.4 other vhosts + 1.4 auth) is deliberately out of scope and will not move. Treat the band as directional, not a pass/fail gate: it assumes the measured 4.2–5.3x ratios hold across a day whose traffic mix will not exactly match Aug 8. **A result near 268 MiB means `gzip_types` is not matching and the change did not take** — that is the signal to act on.

## Acceptance criteria

1. `GET /flowsheet` with `Accept-Encoding: gzip` returns `Content-Encoding: gzip` and `Vary: Accept-Encoding`; decompressed body is byte-identical to the uncompressed response.
2. The same request _without_ `Accept-Encoding` returns an uncompressed body byte-identical to today's.
3. `/events/stream` returns **no** `Content-Encoding` and streams frames live, verified against a real connected client.
4. `/cdc` WebSocket upgrade succeeds and dj-site receives live updates.
5. Conditional-GET 304 behaviour on `/flowsheet` and `/flowsheet/latest` is unchanged.
6. Responses under 1024 bytes are not compressed.
7. `sudo nginx -T` shows `gzip off` inside **both** `location /auth/healthcheck` and `location /auth/`. Stated as a directive assertion on purpose: `/auth/*` averages 262 bytes, so a behavioural "no `Content-Encoding`" check passes whether or not the opt-out was applied and cannot fail.
8. `/etc/nginx/nginx.conf.bak-<date>` exists on the box before the reload.
9. Twenty-four-hour access-log egress shows a material drop from the 268.8 MiB baseline at comparable request volume (~90–110 MiB expected). A reading near 268 MiB fails this criterion; a reading outside the band but clearly reduced does not.
10. `docs/deploy.md` carries the edge-compression subsection and its `@rule` marker (see **Documentation**).

## Documentation

Without this section the plan would leave **zero footprint in the repo** — the whole change would live only on an unversioned box, and its single load-bearing invariant would be recorded nowhere a future reader looks. That is unacceptable in a repo that already has a convention for exactly this.

Add an **Edge compression** subsection to `docs/deploy.md` (the topic guide that already owns deploy/infra invariants) covering: the six directives and where they live, the `/auth/` opt-out and why, the reload procedure, and the rollback. Carry one rule marker in the established form:

```
<!-- @rule id=gzip-types-excludes-sse enforced-by=none added=2026-08-09 -->
```

The rule text: **`text/event-stream` must never be added to `gzip_types`.** `serverEvents.ts` writes SSE frames without `res.flush()` and marks the response `X-Accel-Buffering: no`, so it has no `Content-Length` and `gzip_min_length` cannot gate it — the allowlist is the only thing standing between a routine "let's compress more types" edit and a wedged `/events/stream`. `enforced-by=none` is honest: nothing in CI can see a config file that isn't in the repo, which is itself an argument for the version-control follow-up.

**Do not add a new CLAUDE.md router line.** A `docs/deploy.md` entry already exists at `CLAUDE.md:14` with a topic list — extend that parenthetical in place (~40 chars). CLAUDE.md is currently 149,684 chars against a 16,000-char WARN / 22,000 ALARM in `scripts/check-doc-budget.mjs:38-41`, so it is already far past ALARM and the convention at `CLAUDE.md:194` is explicitly "extract to `docs/` rather than growing CLAUDE.md." The check is warn-only and will fire on this branch regardless of what we do; that is not licence to add to the file. Run `npm run check:doc-budget` / `npm run check:doc-rules` before pushing anyway.

**Also add one inline comment** beside the `'X-Accel-Buffering': 'no'` header at `apps/backend/utils/serverEvents.ts:146`, pointing at `docs/deploy.md` § Edge compression / BS#2076. The rule protects _this_ file, and the person most likely to break it is editing SSE headers, not reading the deploy guide. Dense inline comments carrying an issue reference are the established convention here (`conditionalGet.ts:70-79`, `app.ts:73-79`, `apps/auth/app.ts:408-417`).

## Files

| File                                                | Change                                                                                                                            |
| --------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| `docs/deploy.md`                                    | New **Edge compression** subsection + `@rule id=gzip-types-excludes-sse` marker                                                   |
| `apps/backend/utils/serverEvents.ts`                | One comment line at `:146` pointing at the rule (the only code change)                                                            |
| `CLAUDE.md`                                         | Extend the existing `docs/deploy.md` parenthetical at `:14` in place — **no new router line**                                     |
| `/etc/nginx/nginx.conf` (prod box, **not** in repo) | Six gzip directives in the `api.wxyc.org` server block; `gzip off` on **both** `location /auth/healthcheck` and `location /auth/` |

No migration. No `api.yaml` / `@wxyc/shared` change. The single code edit is a comment.

## Known gap — the config is not in version control

`/etc/nginx/nginx.conf` is hand-edited on a live instance, fronts three hostnames, is under no IaC, and is lost on instance replacement. This change adds six lines to that unversioned surface, and it would be dishonest to present it as complete: it makes an existing structural problem slightly larger.

That problem predates this work and fixing it properly (check the config into `deploy/nginx/`, document the apply step, ideally assert it in CI) is a distinct piece of work with its own review surface. **It should be filed as a follow-up issue and linked from BS#2076**, not folded in here — bundling a config-management change into a six-line performance fix would obscure both. The `docs/deploy.md` rule marker above is the mitigation available within this scope.

## Follow-ups (separate issues, not in scope here)

- **Version-control `/etc/nginx/nginx.conf`** in `deploy/nginx/` with a documented apply procedure. Blocks nothing, but every further edge change compounds the gap above. **There is a working in-repo precedent to copy rather than re-derive:** the `ecr-refresh-cron` job in `deploy-base.yml` idempotently installs host-level state over `appleboy/ssh-action`, documented at `docs/deploy.md:53-63` under `@rule id=ecr-refresh-cron`. That makes `enforced-by=none` on the SSE rule a temporary state with a known path out, not a permanent condition — say so in the `docs/deploy.md` prose.
- **Hoist gzip to the `http { }` block** to pick up `explore.wxyc.org` (semantic-index) and `wiki.wxyc.org`, after this has soaked and with those owners' agreement. There is a concrete win waiting there: a Better Stack uptime bot pulls one of those vhosts' root HTML shells every ~2.5 minutes at **58,280 bytes a hit**, which is most of the 27.4 MB/day "other vhost" bucket and compresses well.
- **Add per-vhost `access_log` files** (or a `log_format` carrying `$host`). The single shared, vhost-blind log is why the first pass of this analysis misattributed 28 MB/day of another service's traffic to Backend-Service; anyone measuring egress here will hit the same trap.
