# TONYDocs — Google Drive Sync Reliability Plan

Source analyzed: `design-review/drive.js` (41 KB, fetched from the Perchance CDN — this is the
actual sync engine, `window.TONYDrive`). Line references are to that file.

## How the current auth + sync works

- **OAuth:** Google Identity Services (GIS) *token client* (`initTokenClient`) → popup → a bare
  access token with `expires_in` (~3600 s). Scope `drive.file`. (`requestToken` L111–160, `connect` L166)
- **No refresh token is ever issued or stored.** The GIS token client cannot produce one (that needs
  authorization-code flow + a server keeping the client secret). `SCOPE` and the flow confirm this.
- **Token is memory-only** and mirrored to `localStorage` for restore within the same hour
  (`saveToken` L201, `restore` L205). `isConnected()` requires >60 s left on the clock (L221).
- **Silent reconnect = `requestAccessToken({prompt:'none'})`**, which only works while a Google
  session cookie is live *and* the browser allows **third-party** cookies in the embedded context.
- **HTTP layer `gfetch` (L228–251):** throws `network` on fetch failure, `auth-expired` on **401**,
  and `drive-http-<status>` on any other non-ok. **It never retries, never backs off.**
- **`syncAll` (L468+):** one linear pass — find folder → list tree → push/pull per file. No
  per-item retry; a thrown error aborts the whole pass. Per-file errors are only collected in the
  push loop (`report.errors`).

## The stability problems (ranked by real-world impact)

| # | Problem | Where | Effect users see |
|---|---------|-------|------------------|
| 1 | **401 → no silent re-auth + retry.** `gfetch` throws immediately on 401 (L240). Nothing calls `connect({interactive:false})` then retries. | `gfetch`, `syncAll` | Sync hard-fails the moment the ~1 h token lapses. The UI even documents this: "press Sync now: one click reconnects." |
| 2 | **No refresh token** — fundamental to the GIS token client. | `requestToken` | Sessions cap at ~1 h regardless of activity. Overnight = guaranteed disconnect. |
| 3 | **Zero retry/backoff** on 429 / 5xx / network blips. | `gfetch` L233–250 | Google rate-limits (429) and transient 500/503 during bulk sync kill the pass and drop edits. |
| 4 | **Third-party-cookie dependency** for `prompt:'none'`. | `requestToken` L157 | Safari ITP + Chrome's cookie phase-out silently break "automatic" reconnect; only manual re-auth works. |
| 5 | **One failure aborts the whole sync.** | `syncAll` | A single bad/huge file stops every other file from syncing. |
| 6 | **No offline/online awareness, no proactive refresh timer.** | app-level | No recovery when connectivity returns; no refresh before expiry. |
| 7 | **No per-request timeout / cancellation.** `gfetch` has no AbortController; only the 20 s GIS *script* load and 180 s auth have timers. | `gfetch` | One hung request stalls the entire sync indefinitely. |

## What we can do — three tiers

### Tier 1 — Resilient HTTP + retry (no architecture change, biggest bang)
1. **Retry with exponential backoff + jitter** inside `gfetch` for `429`, `500`, `502`, `503`, and
   `network` errors. Respect `Retry-After` when Google sends it (429 always does). Cap ~4 attempts.
2. **401 → silent re-auth → retry once:** on 401, `await connect({interactive:false})` (uses
   `prompt:'none'`); if it yields a token, retry the original request **once**. If silent fails, surface a
   clear "reconnect required" state instead of a raw error.
3. **Per-request timeout** via `AbortController` (e.g. 30 s, longer for PDF/office uploads) so a hung
   call can't wedge the pass.
4. **Partial-failure tolerance:** wrap each file's push/pull in try/catch (the push loop already has the
   shape of this at L839), continue the pass, and report a per-file summary rather than aborting.

### Tier 2 — Proactive token lifecycle
5. **Refresh before expiry, not after.** Schedule a silent `prompt:'none'` refresh at ~50 min
   (`isConnected`'s 60 s margin is reactive, not proactive) and on `visibilitychange`→visible + `online`.
6. **`online`/`offline` listeners:** pause polling when offline, trigger a sync the moment connectivity
   returns. Cheap and removes a whole class of "stuck until you notice" failures.

### Tier 3 — Remove the root cause (needs a decision from you)
7. **Move to authorization-code flow + PKCE with a refresh token.** This is the *only* way to get a true
   long-lived refresh token, and it requires a backend to hold the client secret — which conflicts with
   TONYDocs' "local-first, no server" architecture. Options:
   - A minimal token-exchange endpoint (Cloudflare Worker / serverless) that swaps a code for tokens and
     returns only the refresh token to the client; the client then refreshes itself, silently, forever.
   - Or accept Tier 1+2 and keep the GIS token client, treating re-auth as a rare, well-signposted event.

## Constraint / honest limitation

`drive.js` is **the real engine, but it's served from Perchance's CDN and its logic is coupled to
`app.js`** (the `contentProvider`/office-format provider, the sync loop, the 90-second pull timer, and the
UI wiring all live in `app.js`, which I could not fetch — the plugin header explicitly warns the code is
"coupled with the server code"). So **I have designed these fixes but have not implemented or tested
them** — I can't run a live Google OAuth flow or Drive API against a real account from here. Tier 1 and 2
are implementable as a patch to `drive.js` + `app.js`; Tier 3 is an architecture change requiring your
decision and a backend.

## Definition of done
- [ ] 401 triggers one silent re-auth + retry; falls back to a clear reconnect prompt, never a raw error.
- [ ] 429/5xx/network retried with backoff + `Retry-After`; no edit is lost to a blip.
- [ ] Every request has a timeout; hung calls can't stall sync.
- [ ] One file's failure no longer aborts the pass; summary reports per-file outcomes.
- [ ] Token refreshed proactively before expiry and on reconnect/visibility.
- [ ] (If Tier 3) refresh token issued once; silent refresh works with third-party cookies blocked.
