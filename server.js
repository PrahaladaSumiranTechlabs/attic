'use strict';

// Attic - everything you forgot you had.
// A sticky idea wall that runs on hardware everyone else gave up on.
//
// Design constraints (these are the product, not shortcuts):
//   - zero npm dependencies: node:http + node:sqlite only
//   - no WebSocket: XHR polling works from IE6 to current Chrome
//   - no canvas / no WebGL: notes are absolutely positioned divs
//   - /legacy renders the whole wall server-side for browsers with no usable JS

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

const PORT = Number(process.env.PORT || 8080);
const HOST = process.env.HOST || '0.0.0.0';
const DB_PATH = process.env.NOTER_DB || path.join(__dirname, 'noter.db');
const PUBLIC_DIR = path.join(__dirname, 'public');
// Public deployments want the landing page at /; a LAN box wants the wall.
const LANDING_AT_ROOT = process.env.ATTIC_LANDING === '1';

// Wall dimensions in CSS pixels. Big enough to spread out, small enough that an
// old tablet can hold the scroll surface without thrashing.
const WALL_W = 4000;
const WALL_H = 3000;

const COLORS = ['yellow', 'pink', 'blue', 'green', 'orange', 'purple'];

// Templates are just pre-placed notes. No special "column" or "lane" type: a
// kanban header is a wide short note, and the columns are a convention the eye
// enforces, not the schema. That keeps one data model for every layout, and it
// means you can drag a board out of its template whenever it stops fitting.
const TEMPLATES = {
  ideas: {
    label: 'Idea wall',
    blurb: 'Free-form. Put anything anywhere.',
    notes: [
      { x: 60, y: 100, w: 240, h: 160, color: 'yellow',
        text: 'Start anywhere.\n\nDrag notes around. Everything syncs to your other devices in about a second.' },
    ],
  },
  kanban: {
    label: 'Kanban',
    blurb: 'To do / Doing / Done.',
    notes: [
      { x: 60, y: 90, w: 320, h: 64, color: 'pink', text: 'To do' },
      { x: 420, y: 90, w: 320, h: 64, color: 'blue', text: 'Doing' },
      { x: 780, y: 90, w: 320, h: 64, color: 'green', text: 'Done' },
      { x: 60, y: 174, w: 200, h: 150, color: 'yellow', text: 'Drag me to the next column.' },
    ],
  },
  retro: {
    label: 'Retro',
    blurb: 'What worked, what did not, what next.',
    notes: [
      { x: 60, y: 90, w: 320, h: 64, color: 'green', text: 'Went well' },
      { x: 420, y: 90, w: 320, h: 64, color: 'pink', text: "Didn't go well" },
      { x: 780, y: 90, w: 320, h: 64, color: 'blue', text: 'Try next time' },
    ],
  },
  week: {
    label: 'Week',
    blurb: 'Five columns, one per weekday.',
    notes: [
      { x: 60, y: 90, w: 230, h: 56, color: 'orange', text: 'Monday' },
      { x: 320, y: 90, w: 230, h: 56, color: 'orange', text: 'Tuesday' },
      { x: 580, y: 90, w: 230, h: 56, color: 'orange', text: 'Wednesday' },
      { x: 840, y: 90, w: 230, h: 56, color: 'orange', text: 'Thursday' },
      { x: 1100, y: 90, w: 230, h: 56, color: 'orange', text: 'Friday' },
    ],
  },
};

// ---------------------------------------------------------------- storage

const db = new DatabaseSync(DB_PATH);

db.exec(`
  CREATE TABLE IF NOT EXISTS notes (
    id       TEXT PRIMARY KEY,
    wall     TEXT NOT NULL DEFAULT 'main',
    x        INTEGER NOT NULL,
    y        INTEGER NOT NULL,
    w        INTEGER NOT NULL DEFAULT 180,
    h        INTEGER NOT NULL DEFAULT 180,
    text     TEXT NOT NULL DEFAULT '',
    color    TEXT NOT NULL DEFAULT 'yellow',
    author   TEXT NOT NULL DEFAULT '',
    seq      INTEGER NOT NULL,
    deleted  INTEGER NOT NULL DEFAULT 0
  );
  CREATE INDEX IF NOT EXISTS notes_seq ON notes(seq);
  CREATE TABLE IF NOT EXISTS state (k TEXT PRIMARY KEY, v INTEGER NOT NULL);
  INSERT OR IGNORE INTO state (k, v) VALUES ('seq', 0);
`);

// Databases created before walls existed have no `wall` column. Add it rather
// than asking anyone to throw their notes away for a schema change.
// This must run before the index below: CREATE TABLE IF NOT EXISTS is a no-op
// on an existing table, so an index over `wall` would reference a column that
// is not there yet.
const cols = db.prepare(`PRAGMA table_info(notes)`).all().map((c) => c.name);
if (cols.indexOf('wall') === -1) {
  db.exec(`ALTER TABLE notes ADD COLUMN wall TEXT NOT NULL DEFAULT 'main'`);
  console.log('migrated: existing notes moved to wall "main"');
}

db.exec(`CREATE INDEX IF NOT EXISTS notes_wall ON notes(wall, seq)`);

// `seq` stays global rather than per-wall. Every write advances it, so a client
// filtered to one wall still never misses an update, and there is exactly one
// counter to reason about.
const q = {
  bumpSeq: db.prepare(`UPDATE state SET v = v + 1 WHERE k = 'seq'`),
  getSeq: db.prepare(`SELECT v FROM state WHERE k = 'seq'`),
  since: db.prepare(`SELECT * FROM notes WHERE wall = ? AND seq > ? ORDER BY seq`),
  live: db.prepare(`SELECT * FROM notes WHERE wall = ? AND deleted = 0 ORDER BY seq`),
  countLive: db.prepare(`SELECT COUNT(*) AS n FROM notes WHERE wall = ? AND deleted = 0`),
  countAll: db.prepare(`SELECT COUNT(*) AS n FROM notes WHERE deleted = 0`),
  walls: db.prepare(`
    SELECT wall, COUNT(*) AS notes, MAX(seq) AS seq
    FROM notes WHERE deleted = 0 GROUP BY wall ORDER BY seq DESC
  `),
  upsert: db.prepare(`
    INSERT INTO notes (id, wall, x, y, w, h, text, color, author, seq, deleted)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)
    ON CONFLICT(id) DO UPDATE SET
      x = excluded.x, y = excluded.y, w = excluded.w, h = excluded.h,
      text = excluded.text, color = excluded.color, author = excluded.author,
      seq = excluded.seq, deleted = 0
  `),
  softDelete: db.prepare(`UPDATE notes SET deleted = 1, seq = ? WHERE id = ? AND wall = ?`),
};

// ------------------------------------------------------------------ walls

const WALL_RE = /^[a-z0-9][a-z0-9-]{0,47}$/;
const DEFAULT_WALL = 'main';

function cleanWall(v) {
  const s = String(v || '').toLowerCase();
  return WALL_RE.test(s) ? s : DEFAULT_WALL;
}

// Three words beat eight random characters: a wall slug gets read aloud across
// a room at least as often as it gets copied.
const W1 = ['amber', 'brisk', 'calm', 'dusty', 'eager', 'faded', 'glad', 'hazy',
  'idle', 'jolly', 'keen', 'loose', 'mellow', 'noble', 'olive', 'plain',
  'quiet', 'rusty', 'spare', 'tidy', 'usual', 'vivid', 'warm', 'zesty'];
const W2 = ['attic', 'brick', 'cedar', 'drift', 'ember', 'fern', 'grove',
  'hearth', 'inlet', 'juniper', 'kettle', 'lantern', 'meadow', 'nook',
  'orchard', 'pebble', 'quarry', 'ridge', 'stove', 'thicket', 'umber',
  'vessel', 'willow', 'yard'];

function newSlug() {
  const pick = (a) => a[Math.floor(Math.random() * a.length)];
  return pick(W1) + '-' + pick(W2) + '-' + Math.floor(Math.random() * 900 + 100);
}

function nextSeq() {
  q.bumpSeq.run();
  return q.getSeq.get().v;
}

// ---------------------------------------------------------------- presence
// Deliberately in-memory and lossy. Presence is disposable: if the server
// restarts, everyone re-announces within one poll cycle.

const PRESENCE_TTL = 12000; // drop a peer this long after their last heartbeat
const peers = new Map(); // clientId -> { name, vx, vy, vw, vh, color, at }

function touchPeer(id, fields) {
  if (!id) return;
  const prev = peers.get(id) || {
    color: COLORS[peers.size % COLORS.length],
  };
  peers.set(id, Object.assign(prev, fields, { at: Date.now() }));
}

function livePeers(exceptId, wall) {
  const now = Date.now();
  const out = [];
  for (const [id, p] of peers) {
    if (now - p.at > PRESENCE_TTL) {
      peers.delete(id);
      continue;
    }
    if (id === exceptId) continue;
    if (p.wall !== wall) continue; // presence is per-wall
    out.push({
      id,
      name: p.name || 'guest',
      color: p.color,
      vx: p.vx | 0,
      vy: p.vy | 0,
      vw: p.vw | 0,
      vh: p.vh | 0,
      idle: now - p.at > 4000,
    });
  }
  return out;
}

// ---------------------------------------------------------------- helpers

function clampInt(v, lo, hi, dflt) {
  const n = parseInt(v, 10);
  if (isNaN(n)) return dflt;
  return Math.max(lo, Math.min(hi, n));
}

function sendJSON(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    // Old IE caches XHR GETs aggressively; this is not optional.
    'Cache-Control': 'no-cache, no-store, must-revalidate',
    'Pragma': 'no-cache',
    'Expires': '0',
  });
  res.end(body);
}

function readBody(req, cb) {
  let data = '';
  let tooBig = false;
  req.on('data', (c) => {
    data += c;
    if (data.length > 1e6) {
      tooBig = true;
      req.destroy();
    }
  });
  req.on('end', () => cb(tooBig ? null : data));
}

// Accepts both JSON and form-encoded bodies so the no-JS legacy forms and the
// XHR client can share the same handlers.
function parseBody(raw, contentType) {
  if (!raw) return {};
  if (contentType && contentType.indexOf('application/json') !== -1) {
    try {
      return JSON.parse(raw);
    } catch (e) {
      return {};
    }
  }
  const out = {};
  raw.split('&').forEach((pair) => {
    if (!pair) return;
    const i = pair.indexOf('=');
    const k = decodeURIComponent((i < 0 ? pair : pair.slice(0, i)).replace(/\+/g, ' '));
    const v = i < 0 ? '' : decodeURIComponent(pair.slice(i + 1).replace(/\+/g, ' '));
    out[k] = v;
  });
  return out;
}

function normalizeNote(input, seq, wall) {
  const id = String(input.id || '').slice(0, 64) || 'n' + seq + '-' + Math.floor(Math.random() * 1e6);
  return {
    id,
    wall: cleanWall(wall),
    x: clampInt(input.x, 0, WALL_W - 40, 40),
    y: clampInt(input.y, 0, WALL_H - 40, 40),
    w: clampInt(input.w, 80, 600, 180),
    h: clampInt(input.h, 80, 600, 180),
    text: String(input.text == null ? '' : input.text).slice(0, 4000),
    color: COLORS.indexOf(input.color) === -1 ? 'yellow' : input.color,
    author: String(input.author || '').slice(0, 40),
    seq,
  };
}

function rowToNote(r) {
  return {
    id: r.id,
    wall: r.wall,
    x: r.x,
    y: r.y,
    w: r.w,
    h: r.h,
    text: r.text,
    color: r.color,
    author: r.author,
    seq: r.seq,
    deleted: !!r.deleted,
  };
}

function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// ---------------------------------------------------------------- static

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.ico': 'image/x-icon',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
};

function serveStatic(res, urlPath) {
  const rel = urlPath === '/' ? '/index.html' : urlPath;
  const file = path.join(PUBLIC_DIR, path.normalize(rel).replace(/^(\.\.[/\\])+/, ''));
  if (file.indexOf(PUBLIC_DIR) !== 0) {
    res.writeHead(403).end('forbidden');
    return;
  }
  fs.readFile(file, (err, buf) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain' }).end('not found');
      return;
    }
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(file)] || 'application/octet-stream',
      'Content-Length': buf.length,
      'Cache-Control': 'no-cache',
    });
    res.end(buf);
  });
}

// ---------------------------------------------------------------- tier C
// Fully server-rendered wall. No JS, no XHR, no flexbox, no CSS variables.
// Table-free absolute positioning + meta refresh. This is the page a browser
// from the IE-era can actually use, over plain HTTP on the LAN.

function renderLegacy(res, msg, wallId) {
  const notes = q.live.all(wallId).map(rowToNote);
  let html =
    '<html><head><title>Attic</title>' +
    '<meta http-equiv="refresh" content="15">' +
    '<meta http-equiv="Content-Type" content="text/html; charset=utf-8">' +
    '</head><body bgcolor="#f4f1ea" text="#222">' +
    '<h3>Attic &mdash; the wall (basic mode)</h3>' +
    '<p><small>Everything you forgot you had. &nbsp; wall: <b>' + esc(wallId) + '</b></small></p>';

  if (msg) html += '<p><b>' + esc(msg) + '</b></p>';

  html +=
    '<form method="post" action="/legacy/add">' +
    '<input type="hidden" name="wall" value="' + esc(wallId) + '">' +
    'note: <input type="text" name="text" size="40">' +
    ' by: <input type="text" name="author" size="12">' +
    ' x: <input type="text" name="x" size="4" value="60">' +
    ' y: <input type="text" name="y" size="4" value="60">' +
    ' <input type="submit" value="pin it">' +
    '</form><hr>';

  // Positioned view. Old browsers handle absolute divs fine; anything that
  // doesn't will simply stack them in order, which is still readable.
  html += '<div style="position:relative;width:' + WALL_W + 'px;height:' + WALL_H + 'px;">';
  notes.forEach((n) => {
    html +=
      '<div style="position:absolute;left:' + n.x + 'px;top:' + n.y + 'px;' +
      'width:' + n.w + 'px;height:' + n.h + 'px;overflow:hidden;' +
      'background:' + legacyColor(n.color) + ';border:1px solid #999;padding:6px;">' +
      esc(n.text).replace(/\n/g, '<br>') +
      (n.author ? '<br><small>&mdash; ' + esc(n.author) + '</small>' : '') +
      '<br><small><a href="/legacy/del?id=' + encodeURIComponent(n.id) +
      '&w=' + encodeURIComponent(wallId) + '">remove</a></small>' +
      '</div>';
  });
  html += '</div></body></html>';

  res.writeHead(200, {
    'Content-Type': 'text/html; charset=utf-8',
    'Content-Length': Buffer.byteLength(html),
    'Cache-Control': 'no-cache',
  });
  res.end(html);
}

function legacyColor(c) {
  return {
    yellow: '#ffe89a', pink: '#ffc2d1', blue: '#bfe0ff',
    green: '#c6ecc6', orange: '#ffd4a8', purple: '#dcc9f5',
  }[c] || '#ffe89a';
}

// ---------------------------------------------------------------- routes

const server = http.createServer((req, res) => {
  const u = new URL(req.url, 'http://localhost');
  const p = u.pathname;

  // --- poll: state delta + presence heartbeat in a single round trip.
  // One request per cycle matters on old hardware, where each XHR is expensive.
  if (p === '/api/state' && req.method === 'GET') {
    const since = clampInt(u.searchParams.get('since'), -1, 2 ** 31, -1);
    const me = u.searchParams.get('id') || '';
    const wallId = cleanWall(u.searchParams.get('wall'));

    touchPeer(me, {
      wall: wallId,
      name: String(u.searchParams.get('name') || 'guest').slice(0, 40),
      vx: clampInt(u.searchParams.get('vx'), 0, WALL_W, 0),
      vy: clampInt(u.searchParams.get('vy'), 0, WALL_H, 0),
      vw: clampInt(u.searchParams.get('vw'), 0, WALL_W, 0),
      vh: clampInt(u.searchParams.get('vh'), 0, WALL_H, 0),
    });

    const rows = since < 0 ? q.live.all(wallId) : q.since.all(wallId, since);
    sendJSON(res, 200, {
      seq: q.getSeq.get().v,
      full: since < 0,
      wallId,
      notes: rows.map(rowToNote),
      peers: livePeers(me, wallId),
      wall: { w: WALL_W, h: WALL_H },
      colors: COLORS,
    });
    return;
  }

  // A wall is created by being visited, so "new" only has to mint a name that
  // is not already in use.
  if (p === '/api/wall/new' && req.method === 'POST') {
    let slug = newSlug();
    for (let i = 0; i < 8 && q.countLive.get(slug).n > 0; i++) slug = newSlug();
    sendJSON(res, 200, { ok: true, wall: slug, url: '/w/' + slug });
    return;
  }

  if (p === '/api/walls' && req.method === 'GET') {
    sendJSON(res, 200, { walls: q.walls.all() });
    return;
  }

  if (p === '/api/templates' && req.method === 'GET') {
    sendJSON(res, 200, {
      templates: Object.keys(TEMPLATES).map((k) => ({
        key: k,
        label: TEMPLATES[k].label,
        blurb: TEMPLATES[k].blurb,
        count: TEMPLATES[k].notes.length,
      })),
    });
    return;
  }

  if (p === '/api/template' && req.method === 'POST') {
    readBody(req, (raw) => {
      const input = parseBody(raw, req.headers['content-type']);
      const t = TEMPLATES[String(input.name || '')];
      if (!t) {
        sendJSON(res, 404, { ok: false, error: 'no such template' });
        return;
      }
      const wallId = cleanWall(input.wall);
      const author = String(input.author || '').slice(0, 40);
      let seq = 0;
      t.notes.forEach((spec) => {
        seq = nextSeq();
        const n = normalizeNote(Object.assign({}, spec, { author }), seq, wallId);
        q.upsert.run(n.id, n.wall, n.x, n.y, n.w, n.h, n.text, n.color, n.author, n.seq);
      });
      sendJSON(res, 200, { ok: true, seq, added: t.notes.length });
    });
    return;
  }

  if (p === '/api/note' && req.method === 'POST') {
    readBody(req, (raw) => {
      const input = parseBody(raw, req.headers['content-type']);
      const seq = nextSeq();
      const n = normalizeNote(input, seq, input.wall);
      q.upsert.run(n.id, n.wall, n.x, n.y, n.w, n.h, n.text, n.color, n.author, n.seq);
      sendJSON(res, 200, { ok: true, note: n, seq });
    });
    return;
  }

  if (p === '/api/note/delete' && req.method === 'POST') {
    readBody(req, (raw) => {
      const input = parseBody(raw, req.headers['content-type']);
      const id = String(input.id || '');
      const seq = nextSeq();
      q.softDelete.run(seq, id, cleanWall(input.wall));
      sendJSON(res, 200, { ok: true, seq });
    });
    return;
  }

  // --- tier C: no-JS fallback
  if (p === '/legacy' && req.method === 'GET') {
    renderLegacy(res, u.searchParams.get('msg'), cleanWall(u.searchParams.get('w')));
    return;
  }

  if (p === '/legacy/add' && req.method === 'POST') {
    readBody(req, (raw) => {
      const input = parseBody(raw, req.headers['content-type']);
      const wallId = cleanWall(input.wall);
      if (String(input.text || '').trim()) {
        const seq = nextSeq();
        const n = normalizeNote(input, seq, wallId);
        q.upsert.run(n.id, n.wall, n.x, n.y, n.w, n.h, n.text, n.color, n.author, n.seq);
      }
      res.writeHead(302, { Location: '/legacy?w=' + encodeURIComponent(wallId) }).end();
    });
    return;
  }

  if (p === '/legacy/del' && req.method === 'GET') {
    const id = u.searchParams.get('id') || '';
    const wallId = cleanWall(u.searchParams.get('w'));
    q.softDelete.run(nextSeq(), id, wallId);
    res.writeHead(302, { Location: '/legacy?w=' + encodeURIComponent(wallId) }).end();
    return;
  }

  // On a public deployment the front door should be the pitch; on a LAN box it
  // should be the wall. Same binary, one env var.
  if (LANDING_AT_ROOT && (p === '/' || p === '/landing')) {
    serveStatic(res, '/landing.html');
    return;
  }
  if (!LANDING_AT_ROOT && p === '/landing') {
    serveStatic(res, '/landing.html');
    return;
  }
  if (LANDING_AT_ROOT && p === '/wall') {
    serveStatic(res, '/index.html');
    return;
  }

  if (p === '/api/health') {
    sendJSON(res, 200, {
      ok: true,
      notes: q.countAll.get().n,
      walls: q.walls.all().length,
      peers: peers.size,
    });
    return;
  }

  // Any /w/<slug> serves the same app; the client reads the slug from the URL.
  // Visiting a wall is what creates it, exactly like codeshare.
  if (/^\/w\/[a-z0-9][a-z0-9-]{0,47}\/?$/.test(p)) {
    serveStatic(res, '/index.html');
    return;
  }

  serveStatic(res, p);
});

server.listen(PORT, HOST, () => {
  console.log('Attic listening on http://' + HOST + ':' + PORT);
  console.log('  wall      ->  /');
  console.log('  display   ->  /?kiosk=1  (wall-mounted tablet mode)');
  console.log('  basic     ->  /legacy    (no JS, for very old browsers)');
  console.log('  database  ->  ' + DB_PATH);
});
