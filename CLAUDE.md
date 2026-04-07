# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

NSMT Scorebug — a live sports broadcast overlay system ("Project Austin"). This is a standalone, turnkey operator package for non-technical broadcast teams. It has two operating modes:

1. **Local WebSocket mode** — Python or Node.js server on LAN, clients connect via WebSocket
2. **Firebase mode** (current branch: `firebase-yolobox`) — Firebase RTDB for state sync, Cloud Functions for auth, Firebase Hosting for delivery

## Running Locally (WebSocket Mode)

```bash
# Option A: Python
python3 scoreboard_server.py    # requires: pip install websockets

# Option B: Node.js
node websocket-server.js        # requires: npm install ws
```

Both serve HTTP static at `http://localhost:8000` and WebSocket hub at `ws://localhost:8765`. Ports configurable via `NSMT_HTTP_PORT` and `NSMT_WS_PORT` env vars.

## Firebase Commands

```bash
firebase deploy --only functions          # deploy Cloud Functions
firebase deploy --only hosting            # deploy static files to hosting
firebase deploy --only database           # deploy RTDB security rules
firebase deploy --only storage            # deploy Storage rules
node create-event.js <eventId> <operatorPin> <ownerPin> [title]  # create event via CLI
```

Firebase project: `sincere-nirvana-436014-v9`. Functions runtime: Node.js 20 (in `functions/`). Hosting public dir: `public/` (set in `firebase.json`).

### Firebase Hosting Rewrites

- `/o/{eventId}` → `yolo-overlay.html` (overlay shortlink)
- `/c/{eventId}` → `yolo-control.html` (control shortlink)
- `/api/**` → `api` Cloud Function

## Architecture

### Two-tier state model

- **Local mode**: In-memory `STATE` object with three sections: `bug`, `ticker`, `stats`. Clients send `patch` or `set_state` messages; server broadcasts full state to all clients.
- **Firebase mode**: Same three sections stored under `publicEvents/{eventId}/` in RTDB. Auth via PIN-based sessions through Cloud Functions, RTDB rules enforce session validity.

### Key files

| File | Purpose |
|------|---------|
| `yolo-overlay.html` | Broadcast overlay (1920x1080 stage, transparent BG for YoloBox/OBS) |
| `yolo-control.html` | Operator control panel (touch-optimized for iPad) |
| `create-event.html` | Web UI for creating Firebase events |
| `index.html` | Dashboard launcher — links to overlay, control, event creation |
| `functions/index.js` | All Cloud Functions: `createEvent`, `authenticate`, `renewSession`, `revokeOperator`, `rotatePin`, `registerAsset` |
| `database.rules.json` | RTDB security rules (session-based access control) |
| `websocket-server.js` | Node.js local WebSocket + HTTP server |
| `scoreboard_server.py` | Python local WebSocket + HTTP server (original) |
| `ws-client.js` | Browser-side WebSocket helper (auto-reconnect, `NSMTClient` global) |

### Legacy/reference files (not part of Firebase flow)

`nsmt-producer-v2.html`, `nsmt_fox_overlay_ws.html`, `nsmt_fox_control_ws.html`, `stats_v3.html`, `stats_control.html`, `nsmt_overlay.html` — older WebSocket-based producer/overlay/stats pages.

### Message protocol (WebSocket mode)

Clients send: `{ type: "patch", bug: {...} }` or `{ type: "patch", ticker: {...} }` or `{ type: "patch", stats: {...} }`
Server broadcasts: `{ type: "state", data: { bug, ticker, stats } }`
New clients receive: `{ type: "snapshot", data: { bug, ticker, stats } }`

### Firebase auth flow

1. Owner creates event via `createEvent` Cloud Function (sets hashed PINs)
2. Operators/owners authenticate via `authenticate` function (PIN + bcrypt, returns Firebase custom token)
3. Client signs in with custom token, RTDB rules check `sessions/{uid}` for valid session
4. Session renewal via `renewSession`, operator revocation via `revokeOperator`

### RTDB data model (Firebase mode)

```
publicEvents/{eventId}/bug/*        — scorebug state (scores, clock, teams, logos)
publicEvents/{eventId}/ticker/*     — scrolling ticker entries
publicEvents/{eventId}/stats/*      — (future) lightweight stat summary
gameData/{eventId}/*                — current stat state (meta, rosters, onCourt)
gameEvents/{eventId}/*              — chronological stat event log (use child_added, never .on('value'))
gameSubLogs/{eventId}/*             — substitution log (same: child_added only)
adminEvents/{eventId}/*             — hashed PINs, active operator session (never public)
sessions/{uid}/*                    — session records (eventId, role, expiresAt, revoked)
auditLogs/{eventId}/*               — auth/action audit trail
```

Event logs (`gameEvents`, `gameSubLogs`) are sibling nodes flattened away from `gameData` to prevent multi-MB re-downloads on WiFi reconnect.

## Hard Constraints

- **Zero build step** — all client files are plain HTML/JS/CSS. No React, Vue, Svelte, or bundler. This is a hard requirement.
- **Firebase RTDB, not Firestore** — RTDB's ~10ms latency beats Firestore's ~30ms for live broadcast.
- **PIN auth, not email/password** — operators in a gym need 4-digit PIN entry, not account creation. Already secured with bcrypt + rate limiting + custom tokens.
- **No Firebase App Check** — private WiFi with 2-3 known devices makes this disproportionate.
- **Single operator model** — `statsMode` lock ensures only one device writes stats at a time. `onDisconnect()` handles lock release (with grace period to avoid split-brain on brief WiFi drops).

## Known Issues & Active Work

Full adversarial review consolidation: `~/.claude/plans/polished-orbiting-pine.md`

### P0 — Deploy Blockers

1. **Two-database mismatch** — Client HTML files (`yolo-control.html`, `yolo-overlay.html`, `create-event.html`) use `databaseURL: "https://nsmt-scorebug.firebaseio.com"` but Cloud Functions (`functions/index.js`) use `"https://sincere-nirvana-436014-v9-default-rtdb.firebaseio.com"`. Clients and functions are writing to different databases. All must use the same default RTDB instance.

2. **Cloud Functions v1/v2 syntax mismatch** — `functions/index.js` uses v1 callable syntax (`onCall(async (data, context) => {...})`) but `firebase-functions` ^5.1.1 is the v2 SDK. Either rewrite to v2 syntax (`onCall({...}, async (request) => {...})`) or pin to `firebase-functions` v4. Deploying as-is may produce runtime errors.

### P1 — Stat Tracking Architecture

3. **Flatten data model** — Move event logs and sub logs to `gameEvents/{eventId}` and `gameSubLogs/{eventId}` as sibling nodes outside `gameData`. Prevents full re-download on WiFi reconnect.
4. **`child_added` for event logs** — Current overlay/control use `.on('value')` on state refs (acceptable for small `publicEvents` nodes). But stat event logs must never use `.on('value')` — use `child_added` for delta-only delivery.
5. **statsMode locking redesign** — `onDisconnect()` should write `statsDisconnectedAt` timestamp, not immediately clear `statsMode`. Control page only unlocks if timestamp > 30s old. Prevents split-brain on brief WiFi drops.
6. **Score undo via recomputation** — Remove the event push-key with `.remove()`, recompute score from remaining events. No inverse arithmetic.

### P2 — Data Integrity

7. **`.validate` rules** — Add to `database.rules.json`: score `isNumber() && val() >= 0`, `onCourt` `numChildren() <= 5`, required fields on stat entries.
8. **XSS: `textContent` sweep** — `yolo-control.html` has 2 `innerHTML` usages for user-supplied data. Replace with `textContent` before `window.print()`.
9. **`ServerValue.TIMESTAMP`** — All stat event entries must use server timestamps for ordering, not `Date.now()`.
10. **`transaction()` for counters** — Wrap aggregate stat counter updates in RTDB transactions for rapid-tap safety.
11. **Team logos to Cloud Storage** — Move base64 images out of RTDB. `registerAsset` function already exists for this.

## Design System

- Fonts: Space Grotesk (display/headings), Inter (body)
- Primary brand color: `#0E80FC`
- Dark theme throughout — overlay is transparent-background for compositing
- Overlay renders at 1920x1080 with CSS `transform-origin: top left` scaling
