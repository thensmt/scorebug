# NSMT Live System — Setup & Test Guide

## Architecture

```
stats_v3.html  (iPad)  ─┐
nsmt-producer-v2.html  ─┤─► WebSocket Server (:8765) ─► nsmt_fox_overlay_ws.html (OBS)
                         │   HTTP Static     (:8000)
                         └─ scoreboard_server.py  OR  websocket-server.js
```

| File | Role | Sends | Reads |
|---|---|---|---|
| `nsmt-producer-v2.html` | MBP broadcast control | `patch: bug, ticker` | — |
| `stats_v3.html` | iPad stat tracker | `patch: stats, bug` | — |
| `nsmt_fox_overlay_ws.html` | OBS browser source | — | `bug, ticker, stats` |
| `ws-client.js` | Shared WS helper | included by producer + stats | — |

---

## Option A — Python server (existing, recommended)

```bash
cd ~/Desktop/Livestream/scorebugfinal
pip install websockets        # one-time
python3 scoreboard_server.py
```

## Option B — Node.js server (new)

```bash
cd ~/Desktop/Livestream/scorebugfinal
npm install ws                # one-time
node websocket-server.js
```

Both serve:
- HTTP static at `http://localhost:8000`
- WebSocket hub at `ws://localhost:8765`

---

## Running the System

### 1. Start the server (pick one option above)

### 2. Open the producer (MacBook)
```
http://localhost:8000/nsmt-producer-v2.html
```
- Enter team names, load rosters, set WS URL to `ws://localhost:8765`
- Click **Connect WebSocket** → badge turns green
- Click **GO LIVE**

### 3. Open the stat tracker (iPad)
```
http://<MacBook-LAN-IP>:8000/stats_v3.html
```
- Find your Mac's LAN IP: `System Settings → Wi-Fi → Details`
- Stats sync automatically on every logged stat
- Small green dot in bottom-right corner = WS connected

### 4. Add OBS browser source
- URL: `http://localhost:8000/nsmt_fox_overlay_ws.html`
- Width: `1920`, Height: `1080`
- Custom CSS: `body { background: transparent !important; }`

### 5. Enable stats overlay (optional)
In the producer, send `showStats: true` via the overlay toggle, or patch directly:
```js
// In browser console on the producer page:
NSMTClient.send({ type:'patch', bug:{ showStats: true } })
```
This shows the live box score panel on the OBS overlay above the ticker.

---

## Message Schema

### Producer → Server
```json
{ "type": "patch", "bug": { "homeName":"PVI", "homeScore": 42, "clock":"4:22", "clockRunning": true, "quarter":"Q3" } }
{ "type": "patch", "ticker": { "entries": [{"text":"SJC 58 – PVI 42 (FINAL)","flash":0}], "show": true } }
```

### Stats → Server
```json
{ "type": "patch", "stats": {
    "away": { "name":"St. John's", "fouls":8,
      "players": [{ "num":"1","name":"Player","fgm":3,"fga":7,"t3m":1,"t3a":3,
                    "ftm":2,"fta":2,"off":0,"def":4,"ast":3,"stl":1,"blk":0,"to":2,"pf":1,"pts":9 }]
    },
    "home": { ... },
    "meta": { "eventTitle":"WCAC Championship","gameDate":"2026-03-07","gameStatus":"Q3" }
}}
{ "type": "patch", "bug": { "awayScore":42,"homeScore":58,"quarter":"Q3","awayFouls":8,"homeFouls":6 } }
```

### Server → All Clients (on any patch)
```json
{ "type": "state", "data": { "bug":{...}, "ticker":{...}, "stats":{...} } }
```

---

## Troubleshooting

| Problem | Fix |
|---|---|
| Badge stays OFFLINE | Check server is running, firewall allows port 8765 |
| iPad can't connect | Make sure iPad and Mac are on same Wi-Fi; use Mac's LAN IP not `localhost` |
| Stats not showing on overlay | Send `{ type:'patch', bug:{ showStats:true } }` from producer or console |
| Overlay flickers / disconnects | Normal — ws-client.js auto-reconnects every 2 seconds |
| OBS shows black background | Set Custom CSS: `body { background: transparent !important; }` in browser source |
| Score in overlay wrong | Producer score and stats score are independent — producer score wins for the bug |

---

## Files Added / Modified

| File | Status | Notes |
|---|---|---|
| `websocket-server.js` | **New** | Node.js alternative server |
| `ws-client.js` | **New** | Shared WS helper (auto-reconnect) |
| `nsmt-producer-v2.html` | **Patched** | Uses ws-client.js instead of inline WS code |
| `stats_v3.html` | **New** | Copy of NSMT_Stats_v3.html + WS sync added |
| `nsmt_fox_overlay_ws.html` | **Patched** | Added stats panel HTML/CSS + applyStats() |
| `scoreboard_server.py` | Unchanged | Original Python server still works |
