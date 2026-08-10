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
const os = require('node:os');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const qr = require('./lib/qr.js');

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
    blurb: 'Real columns. Cards belong to one.',
    layout: 'kanban',
    columns: ['To do', 'Doing', 'Done'],
    notes: [
      { col: 'To do', ord: 0, color: 'yellow', text: 'Drag me into the next column.' },
      { col: 'To do', ord: 1, color: 'yellow', text: 'Cards stack in their column and stay there.' },
      { col: 'Doing', ord: 0, color: 'blue', text: 'Drop a card between two others to reorder it.' },
    ],
  },
  retro: {
    label: 'Retro',
    blurb: 'Columns: went well, did not, next.',
    layout: 'kanban',
    columns: ['Went well', "Didn't go well", 'Try next time'],
    notes: [
      { col: 'Went well', ord: 0, color: 'green', text: 'Shipping felt quick this week.' },
    ],
  },
  week: {
    label: 'Week',
    blurb: 'A column per weekday.',
    layout: 'kanban',
    columns: ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday'],
    notes: [],
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

  -- A room only needs a row here once it has a name or a layout; rooms still
  -- come into being by being visited, and an unconfigured one has no row.
  CREATE TABLE IF NOT EXISTS walls (
    wall    TEXT PRIMARY KEY,
    title   TEXT NOT NULL DEFAULT '',
    layout  TEXT NOT NULL DEFAULT 'free',
    columns TEXT NOT NULL DEFAULT '[]',
    seq     INTEGER NOT NULL DEFAULT 0
  );
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
// Kanban placement. Freeform notes keep using x/y and leave these alone, so one
// table serves both layouts and a room can switch without losing anything.
if (cols.indexOf('col') === -1) {
  db.exec(`ALTER TABLE notes ADD COLUMN col TEXT NOT NULL DEFAULT ''`);
  db.exec(`ALTER TABLE notes ADD COLUMN ord INTEGER NOT NULL DEFAULT 0`);
  console.log('migrated: notes gained column placement');
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
    INSERT INTO notes (id, wall, x, y, w, h, text, color, author, col, ord, seq, deleted)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)
    ON CONFLICT(id) DO UPDATE SET
      x = excluded.x, y = excluded.y, w = excluded.w, h = excluded.h,
      text = excluded.text, color = excluded.color, author = excluded.author,
      col = excluded.col, ord = excluded.ord,
      seq = excluded.seq, deleted = 0
  `),
  softDelete: db.prepare(`UPDATE notes SET deleted = 1, seq = ? WHERE id = ? AND wall = ?`),

  getMeta: db.prepare(`SELECT * FROM walls WHERE wall = ?`),
  setMeta: db.prepare(`
    INSERT INTO walls (wall, title, layout, columns, seq)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(wall) DO UPDATE SET
      title = excluded.title, layout = excluded.layout,
      columns = excluded.columns, seq = excluded.seq
  `),
  allMeta: db.prepare(`SELECT * FROM walls`),
  dropNotes: db.prepare(`DELETE FROM notes WHERE wall = ?`),
  dropMeta: db.prepare(`DELETE FROM walls WHERE wall = ?`),
};

const DEFAULT_COLUMNS = ['To do', 'Doing', 'Done'];

function wallMeta(slug) {
  const row = q.getMeta.get(slug);
  if (!row) return { wall: slug, title: '', layout: 'free', columns: [], seq: 0 };
  let columns = [];
  try { columns = JSON.parse(row.columns); } catch (e) { columns = []; }
  return {
    wall: row.wall,
    title: row.title,
    layout: row.layout === 'kanban' ? 'kanban' : 'free',
    columns: Array.isArray(columns) ? columns : [],
    seq: row.seq,
  };
}

function saveMeta(slug, patch) {
  const cur = wallMeta(slug);
  const next = {
    title: patch.title === undefined ? cur.title : String(patch.title).slice(0, 60),
    layout: patch.layout === undefined ? cur.layout : (patch.layout === 'kanban' ? 'kanban' : 'free'),
    columns: patch.columns === undefined ? cur.columns
      : (Array.isArray(patch.columns) ? patch.columns : cur.columns)
        .slice(0, 8).map((c) => String(c).slice(0, 40)),
  };
  const seq = nextSeq();
  q.setMeta.run(slug, next.title, next.layout, JSON.stringify(next.columns), seq);
  return Object.assign({ wall: slug, seq }, next);
}

// ------------------------------------------------------------------ walls

const WALL_RE = /^[a-z0-9][a-z0-9-]{0,47}$/;
const DEFAULT_WALL = 'main';

// Names a room may not take, because the router would otherwise never reach the
// real thing behind them.
const RESERVED = new Set([
  'api', 'w', 'legacy', 'landing', 'wall', 'public', 'assets', 'static',
  'index', 'favicon', 'icon', 'health', 'admin', 'login', 'signup', 'about',
  'connect', 'qr', 'support', 'help',
]);

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
    col: String(input.col == null ? '' : input.col).slice(0, 40),
    ord: clampInt(input.ord, 0, 100000, 0),
    seq,
  };
}

// One place to write a note, so the column arguments cannot drift out of sync
// between the four callers that create them.
function writeNote(n) {
  q.upsert.run(n.id, n.wall, n.x, n.y, n.w, n.h, n.text, n.color, n.author, n.col, n.ord, n.seq);
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
    col: r.col || '',
    ord: r.ord || 0,
    seq: r.seq,
    deleted: !!r.deleted,
  };
}

// The whole point of self-hosting is the other devices, so the address they need
// has to be discoverable without anyone running ipconfig.
function lanAddresses() {
  const nets = os.networkInterfaces();
  const out = [];
  for (const name of Object.keys(nets)) {
    for (const net of nets[name] || []) {
      if ((net.family !== 'IPv4' && net.family !== 4) || net.internal) continue;
      out.push({ name, address: net.address });
    }
  }
  // Private ranges first: a VPN or container bridge would otherwise win the
  // top slot and hand out an address nothing on the LAN can reach.
  const isPrivate = (a) => /^(192\.168\.|10\.|172\.(1[6-9]|2\d|3[01])\.)/.test(a);
  out.sort((a, b) => (isPrivate(b.address) ? 1 : 0) - (isPrivate(a.address) ? 1 : 0));
  return out;
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
      // Sent every poll rather than on change: it is a few dozen bytes, and it
      // means a client that joins mid-session never renders the wrong layout.
      meta: wallMeta(wallId),
      notes: rows.map(rowToNote),
      peers: livePeers(me, wallId),
      wall: { w: WALL_W, h: WALL_H },
      colors: COLORS,
      columnPresets: DEFAULT_COLUMNS,
    });
    return;
  }

  // Rename a room, switch its layout, or edit its columns.
  if (p === '/api/wall' && req.method === 'POST') {
    readBody(req, (raw) => {
      const input = parseBody(raw, req.headers['content-type']);
      const wallId = cleanWall(input.wall);
      let columns = input.columns;
      if (typeof columns === 'string') {
        try { columns = JSON.parse(columns); } catch (e) { columns = undefined; }
      }
      sendJSON(res, 200, { ok: true, meta: saveMeta(wallId, {
        title: input.title,
        layout: input.layout,
        columns,
      }) });
    });
    return;
  }

  // Deleting a room is a hard delete, not a tombstone: there is no client that
  // needs to hear about a room it can no longer open, and leaving the notes
  // behind would quietly resurrect them if the name were reused.
  if (p === '/api/wall/delete' && req.method === 'POST') {
    readBody(req, (raw) => {
      const input = parseBody(raw, req.headers['content-type']);
      const wallId = cleanWall(input.wall);
      const removed = q.countLive.get(wallId).n;
      q.dropNotes.run(wallId);
      q.dropMeta.run(wallId);
      for (const [id, peer] of peers) if (peer.wall === wallId) peers.delete(id);
      sendJSON(res, 200, { ok: true, wall: wallId, removed, seq: nextSeq() });
    });
    return;
  }

  // A wall is created by being visited, so "new" only has to mint a name that
  // is not already in use.
  if (p === '/api/wall/new' && req.method === 'POST') {
    let slug = newSlug();
    for (let i = 0; i < 8 && q.countLive.get(slug).n > 0; i++) slug = newSlug();
    sendJSON(res, 200, { ok: true, wall: slug, url: '/' + slug });
    return;
  }

  if (p === '/api/walls' && req.method === 'GET') {
    // Rooms with notes, plus any that exist only as configuration — a freshly
    // named or freshly templated room has metadata before it has content.
    const byName = new Map();
    for (const row of q.walls.all()) {
      byName.set(row.wall, { wall: row.wall, notes: row.notes, seq: row.seq });
    }
    for (const row of q.allMeta.all()) {
      const cur = byName.get(row.wall) || { wall: row.wall, notes: 0, seq: row.seq };
      const meta = wallMeta(row.wall);
      byName.set(row.wall, Object.assign(cur, {
        title: meta.title, layout: meta.layout, columns: meta.columns,
      }));
    }
    const walls = [...byName.values()].sort((a, b) => (b.seq || 0) - (a.seq || 0));
    sendJSON(res, 200, { walls });
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

      // A template that declares columns also switches the room's layout —
      // otherwise "Kanban" would just be some notes shaped like a kanban.
      const meta = saveMeta(wallId, {
        layout: t.layout || 'free',
        columns: t.columns || [],
      });

      let seq = meta.seq;
      t.notes.forEach((spec) => {
        seq = nextSeq();
        writeNote(normalizeNote(Object.assign({}, spec, { author }), seq, wallId));
      });
      sendJSON(res, 200, { ok: true, seq, added: t.notes.length, meta });
    });
    return;
  }

  if (p === '/api/note' && req.method === 'POST') {
    readBody(req, (raw) => {
      const input = parseBody(raw, req.headers['content-type']);
      const seq = nextSeq();
      const n = normalizeNote(input, seq, input.wall);
      writeNote(n);
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
        writeNote(n);
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

  // QR for any short string. Used by the share overlay and the connect page:
  // pointing a tablet camera at a screen beats typing an IP address by hand.
  if (p === '/api/qr.svg' && req.method === 'GET') {
    const text = String(u.searchParams.get('text') || '').slice(0, 200);
    try {
      const svg = qr.toSVG(text, { quiet: 2 });
      res.writeHead(200, {
        'Content-Type': 'image/svg+xml; charset=utf-8',
        'Content-Length': Buffer.byteLength(svg),
        'Cache-Control': 'no-cache',
      });
      res.end(svg);
    } catch (e) {
      res.writeHead(400, { 'Content-Type': 'text/plain' }).end('cannot encode: ' + e.message);
    }
    return;
  }

  if (p === '/api/addresses' && req.method === 'GET') {
    sendJSON(res, 200, { port: PORT, addresses: lanAddresses() });
    return;
  }

  // A page you can leave open on the host machine while you set up tablets.
  if (p === '/connect' && req.method === 'GET') {
    const addrs = lanAddresses();
    const room = cleanWall(u.searchParams.get('w'));
    const suffix = room === DEFAULT_WALL ? '/' : '/' + room;

    let html =
      '<!DOCTYPE html><html><head><meta charset="utf-8">' +
      '<meta name="viewport" content="width=device-width, initial-scale=1">' +
      '<title>Connect a device — Attic</title><style>' +
      'body{margin:0;padding:32px 20px;background:#f4f1ea;color:#23211c;' +
      'font:16px/1.55 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;text-align:center}' +
      'h1{font-size:23px;margin:0 0 4px}p.sub{color:#6f6a5e;margin:0 0 26px;font-size:14px}' +
      '.card{display:inline-block;margin:10px;padding:20px 22px;background:#fff;' +
      'border:1px solid #e2ddd0;border-radius:9px;vertical-align:top}' +
      '.card svg{width:210px;height:210px;display:block;margin:0 auto 12px}' +
      '.url{font-family:ui-monospace,Menlo,Consolas,monospace;font-size:15px;word-break:break-all}' +
      '.iface{font-size:11.5px;color:#9a9384;text-transform:uppercase;letter-spacing:.07em;margin-top:5px}' +
      '.none{color:#b03030}</style></head><body>' +
      '<h1>Point a camera at one of these</h1>' +
      '<p class="sub">Any device on the same network can open the wall this way — ' +
      'no app to install.</p>';

    if (!addrs.length) {
      html += '<p class="none">No network address found. This machine may not be ' +
        'connected to a network, in which case only this computer can reach the wall.</p>';
    }

    for (const a of addrs) {
      const url = 'http://' + a.address + ':' + PORT + suffix;
      html += '<div class="card">' + qr.toSVG(url, { quiet: 2 }) +
        '<div class="url">' + esc(url) + '</div>' +
        '<div class="iface">' + esc(a.name) + '</div></div>';
    }

    html += '</body></html>';
    res.writeHead(200, {
      'Content-Type': 'text/html; charset=utf-8',
      'Content-Length': Buffer.byteLength(html),
      'Cache-Control': 'no-cache',
    });
    res.end(html);
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

  // Rooms live at the bare path — <ip:port>/<room> — because that is what
  // somebody types into a tablet by hand. /w/<room> stays as a longer alias.
  //
  // A room name may not contain a dot, which is what keeps this from shadowing
  // static files: every asset has an extension, no room does.
  const bare = p.match(/^\/([a-z0-9][a-z0-9-]{0,47})\/?$/);
  const aliased = p.match(/^\/w\/([a-z0-9][a-z0-9-]{0,47})\/?$/);
  if (aliased || (bare && bare[1].indexOf('.') === -1 && !RESERVED.has(bare[1]))) {
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
