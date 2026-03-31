#!/usr/bin/env node
/**
 * websocket-server.js — NSMT WebSocket Hub (Node.js)
 * Drop-in alternative to scoreboard_server.py
 *
 * Usage:
 *   npm install ws
 *   node websocket-server.js
 *
 * HTTP static: http://localhost:8000
 * WebSocket:   ws://localhost:8765
 */

const http = require('http');
const fs   = require('fs');
const path = require('path');
const { WebSocketServer } = require('ws');

const HTTP_PORT = parseInt(process.env.NSMT_HTTP_PORT) || 8000;
const WS_PORT   = parseInt(process.env.NSMT_WS_PORT)   || 8765;

// ── MIME types ──
const MIME = {
  '.html':'text/html', '.js':'application/javascript', '.css':'text/css',
  '.png':'image/png',  '.jpg':'image/jpeg', '.jpeg':'image/jpeg',
  '.svg':'image/svg+xml', '.ico':'image/x-icon', '.json':'application/json',
  '.woff2':'font/woff2', '.woff':'font/woff', '.ttf':'font/ttf', '.csv':'text/csv'
};

// ── Initial state (mirrors scoreboard_server.py) ──
function emptyPlayer() {
  return { num:'',name:'',fgm:0,fga:0,t3m:0,t3a:0,ftm:0,fta:0,
           off:0,def:0,ast:0,stl:0,blk:0,to:0,pf:0,pts:0,min:0,pm:0 };
}
function emptyTeam() {
  return { name:'', fouls:0, players: Array.from({length:12}, emptyPlayer) };
}

const STATE = {
  bug: {
    homeName:'Home', awayName:'Away',
    homeScore:0, awayScore:0,
    homeRecord:'', awayRecord:'',
    clock:'8:00', clockRunning:false, quarter:'Q1',
    homeTOs:5, awayTOs:5,
    homeFouls:0, awayFouls:0,
    homeLogo:'', awayLogo:'',
    homePrimary:'#046333', homeSecondary:'#ffffff', homeText:'#ffffff', homeAccent:'#c0c0c0',
    awayPrimary:'#00007f', awaySecondary:'#ffffff', awayText:'#ffffff', awayAccent:'#7f7f7f',
    sponsorLabel:'', sponsorLogo:'', sponsorShow:true,
    promoTLLogo:'', promoTRLogo:'', promoBLLogo:'', promoBarLogo:'',
    cornerTLLogo:'', cornerTRLogo:'', cornerBLLogo:'', cornerBRLogo:'',
    cornerTLScale:100, cornerTRScale:100, cornerBLScale:100, cornerBRScale:100,
    otherGameShow:false, otherAwayName:'', otherAwayScore:0,
    otherHomeName:'', otherHomeScore:0, otherQuarter:'', otherClock:'',
    otherGameScale:100,
    timeoutTeam:'', timeoutType:'', timeoutAt:0,
    showStats:false
  },
  ticker: {
    entries:[], show:false, speed:60
  },
  stats: {
    meta: { eventTitle:'', gameDate:'', gameStatus:'' },
    settings: { showTeamTotals:true },
    away: emptyTeam(),
    home: emptyTeam()
  }
};

// ── Uploads directory ──
const UPLOADS_DIR = path.join(__dirname, 'uploads');
if (!fs.existsSync(UPLOADS_DIR)) fs.mkdirSync(UPLOADS_DIR);

// ── HTTP static server ──
const httpServer = http.createServer((req, res) => {
  const cors = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET,POST,OPTIONS' };

  // File upload endpoint
  if (req.method === 'POST' && req.url === '/upload') {
    const ct = req.headers['content-type'] || '';
    const ext = ct.includes('png') ? '.png' : ct.includes('svg') ? '.svg'
               : ct.includes('gif') ? '.gif' : '.jpg';
    const filename = Date.now() + ext;
    const dest = path.join(UPLOADS_DIR, filename);
    const chunks = [];
    req.on('data', c => chunks.push(c));
    req.on('end', () => {
      fs.writeFile(dest, Buffer.concat(chunks), err => {
        if (err) {
          res.writeHead(500, cors); res.end(JSON.stringify({ error: 'save failed' })); return;
        }
        const url = '/uploads/' + filename;
        res.writeHead(200, { 'Content-Type': 'application/json', ...cors });
        res.end(JSON.stringify({ url }));
      });
    });
    return;
  }

  if (req.method === 'OPTIONS') {
    res.writeHead(204, cors); res.end(); return;
  }

  let urlPath = req.url.split('?')[0];
  if (urlPath === '/') urlPath = '/index.html';

  // Serve uploaded files
  const base = urlPath.startsWith('/uploads/') ? __dirname : __dirname;
  const filePath = path.join(base, urlPath);

  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404, {'Content-Type':'text/plain'});
      res.end('404 Not Found: ' + urlPath);
      return;
    }
    const ext = path.extname(filePath).toLowerCase();
    res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' });
    res.end(data);
  });
});

httpServer.listen(HTTP_PORT, '0.0.0.0', () => {
  console.log(`[HTTP] http://localhost:${HTTP_PORT}`);
});

// ── WebSocket hub ──
const clients = new Set();
const wss = new WebSocketServer({ port: WS_PORT });
console.log(`[WS]   ws://localhost:${WS_PORT}`);

wss.on('connection', (ws) => {
  clients.add(ws);
  // Send full snapshot to new client
  ws.send(JSON.stringify({ type:'snapshot', data:STATE }));

  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }

    if (msg.type === 'patch') {
      // Shallow-merge each top-level section
      for (const k of ['bug', 'ticker', 'stats']) {
        if (msg[k] && typeof msg[k] === 'object') {
          Object.assign(STATE[k], msg[k]);
        }
      }
      broadcast({ type:'state', data:STATE });

    } else if (msg.type === 'set_state') {
      for (const k of ['bug', 'ticker', 'stats']) {
        if (msg[k]) STATE[k] = msg[k];
      }
      broadcast({ type:'state', data:STATE });

    } else if (msg.type === 'get_state') {
      ws.send(JSON.stringify({ type:'snapshot', data:STATE }));

    } else if (msg.type === 'ping') {
      ws.send(JSON.stringify({ type:'pong', ts:Date.now() }));
    }
  });

  ws.on('close', () => clients.delete(ws));
  ws.on('error', () => clients.delete(ws));
});

function broadcast(msg) {
  const payload = JSON.stringify(msg);
  for (const ws of clients) {
    if (ws.readyState === 1 /* OPEN */) {
      try { ws.send(payload); } catch {}
    }
  }
}

process.on('SIGINT', () => {
  console.log('\nShutting down...');
  process.exit(0);
});
