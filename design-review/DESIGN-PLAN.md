# TONYDocs — Design Analysis & Modernization Plan

Scope: the 31.3 KB `<style>` block + DOM inside `outputTemplate` (extracted to `design-review/current-ui.html`).
Evidence gathered from computed styles on the live render and static CSS analysis. Trend grounding from
2025–26 sources (Linear refresh, Atlassian elevation, IBM Carbon motion, web.dev, W3C).

---

## 1. Where the design stands today

### What's already good
- **A real token system.** `:root` defines 4 surface levels (`--bg` → `--surface3`), a border, text/muted,
  an accent + hover + soft-tint, a success color, a 3-step radius scale, and a shadow. This is a genuine
  foundation — most "modernization" is *extending* it, not replacing it.
- **Structure via borders + whitespace, not cards-on-cards.** Panels are separated by 1px borders
  (`--border: #2b333f`) rather than stacked shadows. This matches Atlassian's current elevation guidance.
- **Comfortable document canvas.** The paper (`#pageEl`) keeps a Calibri/Arial 15px, 1.55 line-height white
  page with a soft shadow — the content stays the hero. Correct.
- **Loaded Inter** with a sensible fallback stack.

### The problems (measured, not guessed)

| # | Finding | Evidence |
|---|---------|----------|
| 1 | **Motion is essentially absent** | Whole CSS: **1** `transition` (`transform 0.2s` on the mobile sidebar), **1** `@keyframes` (`ai-pulse`, infinite). No easing curve anywhere (`cubic-bezier`/`ease-*` count = 0). |
| 2 | **Interactions snap with zero feedback** | **23** `:hover` rules, none transitioned. Buttons, file cards, tree items, ribbon controls change state instantly. |
| 3 | **No reduced-motion support** | `prefers-reduced-motion` = **NONE**. Fails modern expectations & WCAG 2.3.3 spirit. |
| 4 | **Invisible keyboard focus** | `:focus-visible` = **0**, one `:focus`, one `outline: none`. Tab navigation is effectively unusable. |
| 5 | **Dark-only, hard-coded** | `color-scheme: dark` set, but no `prefers-color-scheme` block and no theme toggle. (White *document pages* are intentional — paper metaphor — keep those.) |
| 6 | **Radius drift** | Tokens used 29×, but **14** raw-px radii (`4px`,`10px`,`8px`,`6px`,`3px`) bypass the scale → inconsistent corners. |
| 7 | **No type scale** | **21** distinct `font-size` values (9→46px), mostly ad-hoc px. No rhythm, no rem. |
| 8 | **Overlays appear/disappear instantly** | Modals, Drive panel, template picker, and presentation all toggle `hidden` — no enter/exit, no backdrop fade. |
| 9 | **One shadow for everything** | 14 `box-shadow` uses of the single `--shadow` token; no elevation *scale*. |

**Verdict:** the bones are modern and calm; the *feel* is dated purely because nothing animates, focus is
invisible, and there's no motion/accessibility system. This is a high-leverage, low-risk modernization —
we're adding a motion layer and tightening tokens, not redesigning.

---

## 2. Target direction

Quiet, high-clarity utility (Linear '26), borders-first structure (Atlassian), a tokenized motion system
(Carbon), progressive View Transitions (web.dev), and first-class `prefers-reduced-motion`.
No glassmorphism-everywhere, no neon, no perpetual shimmer, no bounce-everything.

---

## 3. The plan

### Phase A — Motion foundation (highest impact, do first)

**A1. Motion tokens** (add to `:root`):
```css
:root {
  /* durations */
  --t-instant: 70ms;   /* press/toggle feedback */
  --t-fast:    120ms;  /* hover, color, small state */
  --t-base:    180ms;  /* menus, disclosure, tooltips */
  --t-slow:    260ms;  /* panels, modals, view change */
  /* easings */
  --ease-standard: cubic-bezier(0.2, 0, 0.38, 0.9);  /* Carbon productive */
  --ease-enter:    cubic-bezier(0.05, 0.7, 0.1, 1.0); /* decelerate */
  --ease-exit:     cubic-bezier(0.3, 0, 0.8, 0.15);   /* accelerate out */
  --ease-spring:   cubic-bezier(0.34, 1.4, 0.5, 1);   /* restrained, direct-manip only */
  /* elevation scale */
  --shadow-1: 0 1px 2px rgba(0,0,0,.30);
  --shadow-2: 0 4px 12px rgba(0,0,0,.35);
  --shadow-3: 0 12px 32px rgba(0,0,0,.45);  /* dialogs/overlays */
}
```

**A2. Global reduced-motion safety net** (must ship with A1):
```css
@media (prefers-reduced-motion: reduce) {
  *, *::before, *::after {
    animation-duration: 1ms !important;
    animation-iteration-count: 1 !important;
    transition-duration: 1ms !important;
    scroll-behavior: auto !important;
  }
}
```

**A3. Micro-interactions on the hot controls** — convert the 23 dead hovers into eased transitions:
```css
.titleBtn, .toolBtn, .ribbonBtn, .ribbonTab, .statusBtn, .sym-btn {
  transition: background-color var(--t-fast) var(--ease-standard),
              border-color var(--t-fast) var(--ease-standard),
              color var(--t-fast) var(--ease-standard),
              transform var(--t-instant) var(--ease-standard),
              box-shadow var(--t-fast) var(--ease-standard);
}
/* press feedback — a 1px "depress", no bounce */
.titleBtn:active, .toolBtn:active, .ribbonBtn:active { transform: translateY(1px); }
/* ribbon toggle state should feel tactile */
.ribbonBtn.active { transition: background-color var(--t-fast) var(--ease-standard),
                                 border-color var(--t-fast) var(--ease-standard); }
```

**A4. File cards & tree items** (JS-populated, so target their classes):
```css
.fileCard {
  transition: border-color var(--t-fast) var(--ease-standard),
              box-shadow var(--t-base) var(--ease-standard),
              transform var(--t-base) var(--ease-enter);
}
.fileCard:hover { transform: translateY(-2px); box-shadow: var(--shadow-2); }
.fileCard:active { transform: translateY(0); }
.treeItem { transition: background-color var(--t-fast) var(--ease-standard),
                        color var(--t-fast) var(--ease-standard); }
.treeKids { transition: none; } /* keep nesting stable */
```

**A5. Overlays: fade + scale enter, fade exit.** Replace instant `hidden` toggles with a class so CSS can
animate (keep `hidden` only for the fully-removed state):
```css
.modalOverlay, .driveOverlay, .templateOverlay, .presentOverlay {
  opacity: 0; transition: opacity var(--t-base) var(--ease-standard);
}
.modalOverlay.open, .driveOverlay.open, .templateOverlay.open, .presentOverlay.open { opacity: 1; }
.modalBox, .driveBox, .templateBox {
  transform: translateY(8px) scale(.98); opacity: 0;
  transition: transform var(--t-slow) var(--ease-enter), opacity var(--t-base) var(--ease-standard);
}
.open .modalBox, .open .driveBox, .open .templateBox { transform: none; opacity: 1; }
```
Requires a tiny JS change: add/remove `.open` alongside `hidden` (app.js drives these).

**A6. Replace the lone infinite pulse.** `ai-pulse` is the only keyframe and it runs forever while AI is
busy — that's the "perpetual shimmer" antipattern. Keep a status pulse but tie it to a real progress affordance
and respect reduced-motion (A2 already clamps it).

### Phase B — Visual polish

**B1. Fix radius drift.** Replace the 14 raw-px radii with `var(--r-sm|md|lg)`; add `--r-xs: 4px` for
tiny controls (color swatches, ruler handles) so nothing needs a raw value.

**B2. Real elevation scale.** Swap the 14 blanket `--shadow` uses for `--shadow-1/2/3` by intent:
inline cards → `-1`; hover/float → `-2`; dialogs & the sticky mobile panes → `-3`. In dark mode lean on the
surface *tone steps* first, shadow second (Atlassian).

**B3. Type scale in rem.** Collapse 21 ad-hoc px sizes into ~6 steps (`--fs-xs:11px` … `--fs-2xl:28px`),
convert to rem, keep chrome compact but leave the reading surface (document body) at a comfortable 15–16px
with ≥1.5 line-height. Don't shrink content text to buy density — remove clutter instead.

**B4. Focus visibility (accessibility, ship with B):**
```css
:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; border-radius: var(--r-xs); }
/* remove the blanket outline:none; scope it only where a custom indicator replaces it */
```

**B5. Light mode.** The app hard-codes dark. Add `@media (prefers-color-scheme: light)` overrides for the
*chrome* (title bar, ribbon, sidebar, status bar) mapping to a light surface ramp; keep document pages white.
Optionally a `data-theme` manual toggle later. (Lower priority — product decision.)

### Phase C — View Transitions (progressive enhancement)

Wrap the highest-continuity navigation in the View Transitions API with a plain fallback:
- **File card → document/sheet/slide editor:** shared-element transition (`.fileCard` → the editor's page).
- **Slide strip reordering / slide select:** shared element on the slide thumbnail → canvas.
- **Sidebar collapse/expand:** already the one existing transition; normalize it to the new tokens.

```js
const go = (fn) => document.startViewTransition
  ? document.startViewTransition(fn)   // falls back to instant when unsupported
  : fn();
```
Never gate navigation on the API (web.dev). Skip on route-level churn; use for 1–2 meaningful jumps only.

### Phase D — Skeletons for real waits
The Drive sync log, PDF load, and initial file-grid paint are the genuine waits. Add static (non-shimmering)
skeleton blocks that hold layout so nothing shifts, with a reduced-motion variant. Don't shimmer forever.

---

## 4. Sequencing & risk

| Phase | Effort | Risk | Impact |
|-------|--------|------|--------|
| A (motion tokens + micro-interactions + reduced-motion) | Low–Med | Low | **Very high** — fixes the "dead/dated" feel |
| B (radius/type/elevation/focus) | Low | Low | High — polish + a11y |
| C (View Transitions) | Med | Med | Medium — delight on key jumps |
| D (skeletons) | Low | Low | Medium — perceived performance |

**Do A + B first**; they're CSS-only for the most part (A5 needs a small JS hook). C and D are additive.

### Constraints to respect
- **The real logic lives in `app.js` (214 KB) on Perchance's CDN, not in this file.** Anything needing JS
  (overlay `.open` toggling, View Transitions wrappers, skeletons) must be edited in `app.js` on Perchance,
  or applied here only if you first recover those sources. Pure CSS (A1–A4, A6, B1–B5) can be layered onto
  `outputTemplate` directly.
- Keep the white document/paper surfaces and print CSS untouched — that's the product, not chrome.
- Preserve information density (Linear): modernize the *feel*, not by removing capability.

---

## 5. Definition of done
- [ ] Every interactive control transitions color/background/transform on hover *and* has `:active` feedback.
- [ ] Motion tokens used consistently; no raw `0.2s`/`ease` left.
- [ ] `prefers-reduced-motion` clamps all motion to ~instant.
- [ ] `:focus-visible` ring on every focusable control; no blanket `outline:none`.
- [ ] Radius drift eliminated; elevation uses the 3-step scale by intent.
- [ ] Type collapsed to a rem scale; reading surface stays ≥15px/1.5.
- [ ] Overlays animate in/out; View Transitions on file→editor and slide select (with fallback).
