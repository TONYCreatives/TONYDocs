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

---

# Appendix: Why a pasted OAuth Client ID fails (diagnosis)

Sources: the actual connect path — `design-review/drive.js` (`loadGis` L104, `requestToken`
L121–158, `connect` L166–183, `setClientId` L42 — trims only, no format validation) and
`design-review/app.js` (`openDriveOverlay` L4605, `driveConnectFlow` L4615–4645,
save/Connect handlers L4884–4897) — plus current Google docs (GIS token model, OAuth
client-side guide, Cloud client management, App Audience; see Sources at the end).

## Connect flow as built
1. Panel saves pasted ID to `localStorage['tonydocs-drive-clientid']` — **no validation**
   beyond `.trim()` (the placeholder's `.apps.googleusercontent.com` suffix check cannot
   catch Android/iOS client IDs, which end the same way).
2. Connect → `initTokenClient` → `requestAccessToken({prompt:''})` popup → Google checks
   the **page's JS origin** against the Client ID's Authorized JavaScript origins.
3. On token: `GET /drive/v3/about` — a second, independent failure point.
4. `app.js` maps any thrown error to one of ~8 friendly log lines.

## Discriminator: what the log/Google window shows

| What you see | What it means | Fix |
|---|---|---|
| `Sign-in timed out.` after ~3 min; Google window shows **Error 400: origin_mismatch / invalid_client** | Origin not registered, wrong project, wrong client type, or un-propagated edit — the popup parks on Google's error page so the callback never fires (`auth-timeout` L133) | See causes 1–4 below |
| `Google blocked this origin (origin_mismatch).` | App matched origin keywords in a callback error | Add the exact pill text (`app.js` L4607 `window.location.origin`) + `https://perchance.org`, no trailing slash; wait **5 min–few hours** (Google's documented propagation) |
| `Sign-in was cancelled or denied.` | `access_denied` — consent denied, **or** account not on the Testing test-user list, **or** unverified-app block | Consent screen → Testing → add your account; or publish |
| `Connect failed (drive-http-403).` | **Auth succeeded**; Drive API not enabled in that project (or scope missing) — distinct signature | APIs & Services → Enable **Google Drive API** in the SAME project |
| `Popup was blocked.` | Popup blocker | Allow popups |
| `Could not reach Google sign-in.` (`gis-load`/`gis-timeout`) | accounts.google.com blocked/unreachable | Disable blocker for Google domains |
| `No Client ID yet.` | Empty input / not saved | Step 2 |

## Ranked root causes for "client ID is failing"

1. **Running the downloaded copy from `file://`** — this conversation started from a
   downloaded `tonydocs.html`. A `file://` page's origin (`file://` / `null`) **cannot be
   registered** in Authorized JavaScript origins (Google allows only http(s) domains;
   `localhost`/`127.0.0.1` by name, ports must match exactly). The app does **no**
   protocol guard, and the origin pill would display the unusable value. ⇒ OAuth from a
   local file **always fails**. Serve over `http://localhost:<port>` instead.
2. **Origin/project mismatch or propagation lag** — origin added to a *different* Cloud
   project than the one owning the ID (the panel warns about both), or edited <5 min ago.
   Also: `localhost` ≠ `127.0.0.1` ≠ dev-server port ≠ `perchance.org`; iframe embeds
   initiate from the **frame's** origin.
3. **Wrong client type** — Android/iOS client ID pasted (suffix looks identical).
   Symptom: Error 400 `invalid_client` in the popup.
4. **Testing/consent block** — external app in Testing needs the authorizing account on
   the test-user list (its grant then expires every 7 days); unverified apps show
   "Access blocked". Owner is **not** automatically exempt.
5. **Drive API disabled** — only after a successful popup; signature is
   `drive-http-403` on the `/about` call.
6. **Popup/GIS reachability** — blocker, embed sandboxing, or `prompt:'none'` quiet
   reconnect with no live Google session (needs third-party cookies; Chrome keeps its
   user-choice model since Apr 2025 — Incognito blocks them by default).

## Code-level observations (diagnosis, not yet fixed)
- `setClientId` saves **anything** — a client *secret* or truncated ID passes silently.
  A cheap fix: reject on save unless `/^\d{6,}-[\w-]+\.apps\.googleusercontent\.com$/`.
- The friendly-message mapping **swallows Google's actual error text**: the
  `denied`-keyword branch (`app.js` L4641) matches `auth-denied error=invalid_client…`
  and shows only "cancelled or denied", hiding the real cause. Append `(details: …)`
  with the raw message in every branch so support can discriminate.
- Timeout branch hints at origin_mismatch but not `invalid_client`; mention both.
- No `file://` guard where the pill is rendered (`app.js` L4607) — show
  "Local file — serve over localhost to use Drive" when
  `location.protocol === 'file:'`.

## What could not be verified here
No live browser/Google account/Cloud console is available in this environment, so this is
a static diagnosis of the code path + Google's documented behavior, not a reproduction.
The single fastest confirmation: **the exact text in the Google popup window** (or the
full `Connect failed (…)` / log line) — it maps 1:1 to the discriminator table above.

Sources: [GIS token model](https://developers.google.com/identity/oauth2/web/guides/use-token-model) ·
[OAuth client-side guide](https://developers.google.com/identity/protocols/oauth2/javascript-implicit-flow) ·
[Manage OAuth clients / origin propagation](https://support.google.com/cloud/answer/15549257) ·
[Manage App Audience / test users / 7-day expiry](https://support.google.com/cloud/answer/15549945) ·
[Unverified apps](https://support.google.com/cloud/answer/7454865) ·
[Drive scopes](https://developers.google.com/workspace/drive/api/guides/api-specific-auth) ·
[Chrome third-party cookie user-choice decision (Apr 2025)](https://privacysandbox.google.com/blog/privacy-sandbox-next-steps)
