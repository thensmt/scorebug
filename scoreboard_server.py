#!/usr/bin/env python3
# scoreboard_server.py
# HTTP static server + WebSocket hub for instant updates.
# HTTP: http://localhost:8000
# WS  : ws://localhost:8765
# Requires:  pip install websockets

import asyncio, json, threading, os, time, mimetypes
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer

try:
    import websockets
except Exception:
    print("Missing dependency. Install with:  pip install websockets")
    raise

HTTP_PORT = int(os.environ.get("NSMT_HTTP_PORT", "8000"))
WS_PORT   = int(os.environ.get("NSMT_WS_PORT", "8765"))

# In-memory state (sent to every new client as a snapshot)
def _empty_player():
    return {
        "num": "",
        "name": "",
        "fgm": 0, "fga": 0,
        "t3m": 0, "t3a": 0,
        "ftm": 0, "fta": 0,
        "off": 0, "def": 0,
        "ast": 0, "stl": 0, "blk": 0,
        "to": 0, "pf": 0,
        "min": 0, "pm": 0
    }

def _empty_team():
    return {
        "name": "",
        "fouls": 0,
        "players": [_empty_player() for _ in range(12)]
    }

STATE = {
    "bug": {
        "homeName":"South County","awayName":"Landstown",
        "homeScore":0,"awayScore":0,
        "homeRecord":"20-7","awayRecord":"23-4",
        "clock":"8:00","clockRunning":False,"quarter":"1st",
        "playClock":14,"playClockRunning":False,
        "downDistance":"1st & 10","ddPlacement":"home",   # 'home' | 'away' | 'off'
        "homeColor":"#0c2a57","awayColor":"#0E80FC",     # D&D bar colors
        "homeTOs":5,"awayTOs":5,
        "homeLogo":"southcountystallions.png","awayLogo":"landstowneagles.png",
        "homePrimary":"#046333","homeSecondary":"#ffffff","homeText":"#ffffff","homeAccent":"#c0c0c0",
        "awayPrimary":"#00007f","awaySecondary":"#ffffff","awayText":"#ffffff","awayAccent":"#7f7f7f",
        "sponsorLabel":"NIT - 1st ROUND","sponsorLogo":"","sponsorShow":True,
        "promoTLLogo":"silver-hoopfest-logo.png",
        "promoTRLogo":"",
        "promoBLLogo":"",
        "promoBarLogo":"NSMTWordmarkBlue.png",
        "cornerTLLogo":"","cornerTRLogo":"","cornerBLLogo":"","cornerBRLogo":"",
        "cornerTLScale":100,"cornerTRScale":100,"cornerBLScale":100,"cornerBRScale":100,
        "otherGameScale":100,
        "timeoutTeam":"","timeoutType":"","timeoutAt":0
    },
    "ticker": {
        "entries":[{"text":"FINAL: Centreville 28 - Westfield 21","flash":0}],
        "show": False,
        "speed": 60   # seconds per full pass (adjust in console)
    },
    "stats": {
        "meta": {
            "eventTitle": "WCAC",
            "gameDate": "",
            "gameStatus": ""
        },
        "settings": {
            "showTeamTotals": True
        },
        "away": _empty_team(),
        "home": _empty_team()
    }
}

# Extra game score (top-right mini tracker)
STATE["bug"].update({
    "otherGameShow": True,
    "otherAwayName": "Manchester",
    "otherAwayScore": 0,
    "otherHomeName": "Westfield",
    "otherHomeScore": 0,
    "otherQuarter": "1st",
    "otherClock": "8:00"
})

CLIENTS = set()

async def ws_handler(websocket):
    CLIENTS.add(websocket)
    # Send current snapshot immediately
    await websocket.send(json.dumps({"type":"snapshot","data":STATE}))
    try:
        async for message in websocket:
            data = json.loads(message)
            kind = data.get("type")
            if kind == "set_state":
                for k in ("bug","ticker","stats"):
                    if k in data:
                        STATE[k] = data[k]
                await broadcast({"type":"state","data":STATE})
            elif kind == "patch":
                for k in ("bug","ticker","stats"):
                    if k in data:
                        STATE[k].update(data[k])
                await broadcast({"type":"state","data":STATE})
            elif kind == "get_state":
                await websocket.send(json.dumps({"type":"snapshot","data":STATE}))
            elif kind == "ping":
                await websocket.send(json.dumps({"type":"pong","ts":time.time()}))
    finally:
        CLIENTS.discard(websocket)

async def broadcast(msg: dict):
    if not CLIENTS: return
    payload = json.dumps(msg)
    dead = []
    for ws in list(CLIENTS):
        try:
            await ws.send(payload)
        except Exception:
            dead.append(ws)
    for ws in dead:
        CLIENTS.discard(ws)

UPLOADS_DIR = os.path.join(os.path.dirname(__file__) or '.', 'uploads')
os.makedirs(UPLOADS_DIR, exist_ok=True)

def start_http():
    class Handler(SimpleHTTPRequestHandler):
        def log_message(self, fmt, *args):
            return
        def do_POST(self):
            if self.path == '/upload':
                ct = self.headers.get('Content-Type', '')
                ext = '.png' if 'png' in ct else '.svg' if 'svg' in ct else '.gif' if 'gif' in ct else '.jpg'
                filename = str(int(time.time() * 1000)) + ext
                dest = os.path.join(UPLOADS_DIR, filename)
                length = int(self.headers.get('Content-Length', 0))
                data = self.rfile.read(length)
                with open(dest, 'wb') as f:
                    f.write(data)
                url = '/uploads/' + filename
                body = json.dumps({'url': url}).encode()
                self.send_response(200)
                self.send_header('Content-Type', 'application/json')
                self.send_header('Access-Control-Allow-Origin', '*')
                self.end_headers()
                self.wfile.write(body)
            else:
                self.send_response(404)
                self.end_headers()
        def do_OPTIONS(self):
            self.send_response(204)
            self.send_header('Access-Control-Allow-Origin', '*')
            self.send_header('Access-Control-Allow-Methods', 'GET,POST,OPTIONS')
            self.end_headers()
    httpd = ThreadingHTTPServer(("0.0.0.0", HTTP_PORT), Handler)
    print(f"[HTTP] Serving static at http://localhost:{HTTP_PORT}")
    httpd.serve_forever()

async def start_ws():
    print(f"[WS] WebSocket hub at ws://localhost:{WS_PORT}")
    async with websockets.serve(ws_handler, "0.0.0.0", WS_PORT, max_size=1<<20):
        await asyncio.Future()  # run forever

if __name__ == "__main__":
    threading.Thread(target=start_http, daemon=True).start()
    try:
        asyncio.run(start_ws())
    except KeyboardInterrupt:
        print("Shutting down...")
