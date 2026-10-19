# TONYDocs

Free, open-source, local-first docs suite with MS Office vibe. Single-user V1.

Owner: Tony Lee. License: MIT (see [LICENSE](LICENSE)).

Live app: https://perchance.org/tonydocs

## Suite (all live)
- Docs: Word-style editor (ribbon: Home/Insert/Layout/Review/AI/View), export HTML/**DOCX**/TXT, Print to PDF
- DOCX round-trip: export via `docx` lib (headings, rich text, bullets + numbering, tables with spans/shading, embedded images, page breaks, headers/footers with live page numbers); import via `mammoth` (text, lists, tables, embedded images). Both load on demand from CDN — offline shows a notice, HTML export always works.
- Templates gallery: Meeting Notes, Project Report, Formal Letter, Resume, Newsletter
- Outline pane + comments pane (right side, one at a time; drawers on mobile)
- AI writing (ai-text-plugin): Continue/Custom at caret with live streaming + Stop, Rewrite/Shorten/Expand on selection
- TONYSheet: grid with SUM/AVERAGE/MIN/MAX/COUNT/PRODUCT/ABS/SQRT/ROUND, CSV import/export, XLSX export, Print to PDF
- TONYSlide: 5 layouts, 4 themes, present mode, PPTX export, Print to PDF
- PDF files: import any .pdf up to 25 MB, viewer, download, Print via native toolbar
- Google Drive popup sync: Google sign-in popup, TONYDocs folder, bidirectional last-write-wins with conflict copies, auto-sync + Sync now + log
- Folders with nesting, search, rename, delete, file cards
- Autosave to `root.kv.tonydocs` (IndexedDB) with localStorage fallback (PDF bytes and Drive token live in IndexedDB/memory only)

## Project layout (source lives on Perchance)
- `main.pjs` — metadata + `kv = {import:kv-plugin}` + `generateText = {import:ai-text-plugin}` (AI tab; note: the plugin shows an ad to logged-out visitors)
- `index.html` — shell markup + styles, Drive panel overlay, template gallery overlay
- `src/app.js` — app logic + Drive panel wiring, classic script, no build step (W-sections: W1 ribbon shell, W2 Home depth, W3 Insert power, W4 layout, W5 review incl. spell/track, W6 templates/outline/DOCX, W7 AI)
- `src/drive.js` — Drive sync engine (auth, folder ensure, push/pull, conflicts), injectable fetch for tests
- `src/dict.js`, `src/dict-core.js` — offline spellcheck wordlists (frequency list + core English), loaded as `window.TONY_DICT` / `window.TONY_CORE`
- `src/README.md` — the upstream copy of this file

## This repository
- [design-review/DESIGN-PLAN.md](design-review/DESIGN-PLAN.md) — UI design analysis + modernization plan (motion tokens, accessibility, View Transitions)
- [design-review/DRIVE-RELIABILITY.md](design-review/DRIVE-RELIABILITY.md) — Google Drive sync reliability analysis + fix plan (retry/backoff, token lifecycle)
- [design-review/current-ui.html](design-review/current-ui.html) — the app's UI shell (markup + styles) extracted for design review; open it directly in a browser
- [design-review/drive.js](design-review/drive.js) — mirror of the Drive sync engine source

## Icons
- All UI icons are inline SVG: a `<symbol>` sprite (`#i-*`) at the top of `index.html`, used via `<svg class="ic"><use href="#i-*"/></svg>`. No emoji in shipped UI.
- `src/app.js` `fileIcon()` returns the file-type SVG strings; Drive button state swaps cloud/check icons via `innerHTML`.

## Data model
File: `{id, name, type: doc|sheet|slide|pdf|folder, parentId, contentHTML, grid, deck, size, data, createdAt, updatedAt}`
Doc extras: `layout {paper, orient, m, cols}` (W4), `comments [{id, text, createdAt}]` anchored by `[data-cid]` spans (W5).
PDF entry: `{size, data: Uint8Array}` plus `missing: true` when only the metadata backup is present.
Drive linkage is NOT stored on files; it lives in Drive meta (`tonydocs-drive-meta`): `{lastSyncAt, byId: {localId: {driveId, driveModifiedTime, localUpdatedAt, name, driveGone}}}`.

## Runtime CDN libraries (loaded on demand, offline-safe with notice)
- DOCX export: `docx@9.1.0` UMD (`window.docx`) — `https://unpkg.com/docx@9.1.0/build/index.umd.js`
- DOCX import: `mammoth@1.9.1` browser bundle (`window.mammoth`) — `https://unpkg.com/mammoth@1.9.1/mammoth.browser.min.js`
- XLSX export / PPTX export use jsdelivr/unpkg similarly (see `ensureXLSX` / `ensurePptx`).
- `loadScriptOnce(src)` dedupes by `data-tony` attr. Pin versions when bumping; re-verify export shapes (HeadingLevel/LevelFormat/PageNumber/ImageRun/ExternalHyperlink APIs).

## Drive sync design
- One Drive file per local file, matched by `appProperties.tonydocsId`. Docs/sheets/slides sync as real Office files (`.docx` / `.xlsx` / `.pptx` via the app's own exporters) so Drive previews them as actual documents. Each file embeds the lossless `tonydocs-file-v1` record at `tonydocs/record.json` inside the zip (ignored by Word/Excel/PowerPoint) and sync restores from that embed — formatting in the preview may differ slightly, the data never does. Folders are real Drive folders, PDFs raw bytes. Legacy raw-JSON and interim `.html` copies still read, and auto-upgrade on the next sync. If the Office libraries fail to load, sync falls back to an `.html` snapshot temporarily. Edit in TONYDocs; Drive copies are previews.
- Local delete trashes the Drive copy. Drive-side deletes never delete local data (respects the delete, stops re-uploading until the file changes again).
- Both-sides-changed: newer `updatedAt` wins; if Drive wins the local version is kept as `name (conflict copy)`.
- Scope is `drive.file` (only files TONYDocs itself created). Session persists on this device (token + expiry in localStorage) so refresh reconnects instantly with no popup; silent top-up when expired, revoke on disconnect.
- Needs a free Google Cloud OAuth Client ID (Web application) with the app origins allow-listed; the panel shows both origins with a copy button.
- Google access tokens last ~1 hour by Google's rule (no refresh tokens in browser-only OAuth, so this is a hard limit). Behavior: pushes go out ~6s after edits; a visible tab pulls every 90s; every revisit (focus/visible/online) syncs or quietly reconnects; an open tab tops the session up silently before it expires. Boot always tries restore-then-quiet-reconnect (never a popup); a mid-sync 401 triggers one quiet retry before disconnecting; Sync now reconnects interactively in one click and then syncs. The button keeps its "Drive" label while linked (green only with a live session); the account line shows time left, or one-click reconnect when lapsed. Quiet reconnect needs Google third-party cookies allowed (Chrome blocks them by default, so next-day revisits usually need the one click); interactive popup uses default consent (no forced re-consent).
