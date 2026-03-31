#!/usr/bin/env python3
# live_editing_server.py
# Static HTTP server plus lightweight WebSocket helper for the Live Editing folder.
# HTTP: http://localhost:8020 (configurable via LIVE_HTTP_PORT)
# WS  : ws://localhost:8767 (configurable via LIVE_WS_PORT)
# Requires:  pip install websockets

import asyncio, json, os, threading, time
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer

try:
    import websockets
except Exception:
    print("Missing dependency. Install with:  pip install websockets")
    raise

# Default location for the Live Editing directory; override with LIVE_EDIT_DIR if needed.
LIVE_EDIT_DIR = os.path.realpath(os.path.expanduser(
    os.environ.get(
        "LIVE_EDIT_DIR",
        "/Users/david/Library/CloudStorage/GoogleDrive-david@nsmtsports.com/My Drive/NSMT - Content/Media/Live Editing"
    )
))

HTTP_PORT = int(os.environ.get("LIVE_HTTP_PORT", "8020"))
WS_PORT   = int(os.environ.get("LIVE_WS_PORT", "8767"))

if not os.path.isdir(LIVE_EDIT_DIR):
    raise SystemExit(f"Live Editing directory not found: {LIVE_EDIT_DIR}")


def list_live_entries():
    """Return a shallow listing of the Live Editing directory."""
    entries = []
    with os.scandir(LIVE_EDIT_DIR) as it:
        for entry in it:
            stat = entry.stat()
            entries.append({
                "name": entry.name,
                "isDir": entry.is_dir(),
                "size": stat.st_size,
                "mtime": stat.st_mtime
            })
    return entries


def start_http():
    class Quiet(SimpleHTTPRequestHandler):
        def log_message(self, fmt, *args):  # silence console spam
            return

    handler = partial(Quiet, directory=LIVE_EDIT_DIR)
    httpd = ThreadingHTTPServer(("0.0.0.0", HTTP_PORT), handler)
    print(f"[HTTP] Serving {LIVE_EDIT_DIR} at http://localhost:{HTTP_PORT}")
    httpd.serve_forever()


async def ws_handler(websocket):
    # Send initial info and listing
    await websocket.send(json.dumps({
        "type": "hello",
        "dir": LIVE_EDIT_DIR,
        "ts": time.time()
    }))
    await websocket.send(json.dumps({
        "type": "listing",
        "entries": list_live_entries()
    }))

    async for message in websocket:
        data = json.loads(message)
        kind = data.get("type")
        if kind == "ping":
            await websocket.send(json.dumps({"type": "pong", "ts": time.time()}))
        elif kind == "list":
            await websocket.send(json.dumps({
                "type": "listing",
                "entries": list_live_entries()
            }))


async def start_ws():
    print(f"[WS] WebSocket helper at ws://localhost:{WS_PORT}")
    async with websockets.serve(ws_handler, "0.0.0.0", WS_PORT, max_size=1 << 20):
        await asyncio.Future()  # run forever


if __name__ == "__main__":
    threading.Thread(target=start_http, daemon=True).start()
    try:
        asyncio.run(start_ws())
    except KeyboardInterrupt:
        print("Shutting down...")
