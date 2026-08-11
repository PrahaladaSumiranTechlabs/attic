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

// Read once at startup. A version nobody can see is a version nobody can
// report in a bug, so this is surfaced in the app rather than only in git.
const VERSION = (() => {
  // The desktop app passes this in, because a packaged server runs from
  // app.asar.unpacked where package.json is not unpacked alongside it — reading
  // it from disk there fails and the app reports its version as "unknown".
  if (process.env.ATTIC_VERSION) return process.env.ATTIC_VERSION;
  try {
    return JSON.parse(fs.readFileSync(path.join(__dirname, 'package.json'), 'utf8')).version;
  } catch (e) {
    return 'unknown';
  }
})();

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

// Every widget here renders from the browser alone. Nothing fetches, nothing
// needs a key, nothing leaves the network — which is what lets the security
// model on the landing page stay true. A weather tile would need outbound
// network and an API key, and a system-stats tile would need an agent on the
// host; both are a different product wearing this one's clothes.
const KINDS = ['note', 'clock', 'date', 'countdown', 'qr'];

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

  -- Connections between two notes. Kept as their own rows rather than a field
  -- on a note, because a link belongs to neither end of it.
  CREATE TABLE IF NOT EXISTS links (
    id      TEXT PRIMARY KEY,
    wall    TEXT NOT NULL,
    a       TEXT NOT NULL,
    b       TEXT NOT NULL,
    seq     INTEGER NOT NULL,
    deleted INTEGER NOT NULL DEFAULT 0
  );
  CREATE INDEX IF NOT EXISTS links_wall ON links(wall, seq);

  -- Where a room used to live. Renaming a room moves its address, and a tablet
  -- on a wall is still pointing at the old one — so old addresses keep working
  -- instead of quietly becoming a new empty room.
  CREATE TABLE IF NOT EXISTS wall_aliases (
    old  TEXT PRIMARY KEY,
    wall TEXT NOT NULL
  );

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
// Widgets are notes with a kind, rather than a second kind of object with its
// own table, sync path and bugs. A clock is a note that draws a clock. It
// inherits placement, dragging, undo, e-ink and read-only sharing for free.
if (cols.indexOf('kind') === -1) {
  db.exec(`ALTER TABLE notes ADD COLUMN kind TEXT NOT NULL DEFAULT 'note'`);
  console.log('migrated: notes gained a kind');
}

const wallCols = db.prepare(`PRAGMA table_info(walls)`).all().map((c) => c.name);
if (wallCols.length && wallCols.indexOf('view_token') === -1) {
  db.exec(`ALTER TABLE walls ADD COLUMN view_token TEXT NOT NULL DEFAULT ''`);
  console.log('migrated: rooms gained share tokens');
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
    INSERT INTO notes (id, wall, x, y, w, h, text, color, author, col, ord, kind, seq, deleted)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)
    ON CONFLICT(id) DO UPDATE SET
      x = excluded.x, y = excluded.y, w = excluded.w, h = excluded.h,
      text = excluded.text, color = excluded.color, author = excluded.author,
      col = excluded.col, ord = excluded.ord, kind = excluded.kind,
      seq = excluded.seq, deleted = 0
  `),
  softDelete: db.prepare(`UPDATE notes SET deleted = 1, seq = ? WHERE id = ? AND wall = ?`),

  linksSince: db.prepare(`SELECT * FROM links WHERE wall = ? AND seq > ? ORDER BY seq`),
  linksLive: db.prepare(`SELECT * FROM links WHERE wall = ? AND deleted = 0 ORDER BY seq`),
  linkInsert: db.prepare(`INSERT INTO links (id, wall, a, b, seq, deleted) VALUES (?, ?, ?, ?, ?, 0)`),
  linkExists: db.prepare(`
    SELECT id FROM links WHERE wall = ? AND deleted = 0
      AND ((a = ? AND b = ?) OR (a = ? AND b = ?))
  `),
  linkDelete: db.prepare(`UPDATE links SET deleted = 1, seq = ? WHERE id = ? AND wall = ?`),
  restoreNote: db.prepare(`UPDATE notes SET deleted = 0, seq = ? WHERE id = ? AND wall = ?`),
  deadNote: db.prepare(`SELECT * FROM notes WHERE id = ? AND wall = ? AND deleted = 1`),
  noteAlive: db.prepare(`SELECT id FROM notes WHERE id = ? AND wall = ? AND deleted = 0`),
  deadLinksFor: db.prepare(`
    SELECT * FROM links WHERE wall = ? AND deleted = 1 AND (a = ? OR b = ?)
  `),
  restoreLink: db.prepare(`UPDATE links SET deleted = 0, seq = ? WHERE id = ?`),
  // A note that goes away takes its connections with it; a line to nothing is
  // worse than no line.
  linksForNote: db.prepare(`
    UPDATE links SET deleted = 1, seq = ? WHERE wall = ? AND deleted = 0 AND (a = ? OR b = ?)
  `),
  dropLinks: db.prepare(`DELETE FROM links WHERE wall = ?`),

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
  alias: db.prepare(`SELECT wall FROM wall_aliases WHERE old = ?`),
  addAlias: db.prepare(`
    INSERT INTO wall_aliases (old, wall) VALUES (?, ?)
    ON CONFLICT(old) DO UPDATE SET wall = excluded.wall
  `),
  // Any alias that pointed at the old address should follow the room forward,
  // so a chain of renames never needs more than one hop to resolve.
  repointAliases: db.prepare(`UPDATE wall_aliases SET wall = ? WHERE wall = ?`),
  clearAlias: db.prepare(`DELETE FROM wall_aliases WHERE old = ?`),
  dropAliasesTo: db.prepare(`DELETE FROM wall_aliases WHERE wall = ?`),
  moveNotes: db.prepare(`UPDATE notes SET wall = ? WHERE wall = ?`),
  moveLinks: db.prepare(`UPDATE links SET wall = ? WHERE wall = ?`),
  moveMeta: db.prepare(`UPDATE walls SET wall = ? WHERE wall = ?`),
  byToken: db.prepare(`SELECT * FROM walls WHERE view_token = ? AND view_token != ''`),
  setToken: db.prepare(`
    INSERT INTO walls (wall, title, layout, columns, seq, view_token)
    VALUES (?, '', 'free', '[]', ?, ?)
    ON CONFLICT(wall) DO UPDATE SET view_token = excluded.view_token, seq = excluded.seq
  `),
};

// A read-only link is addressed by token, never by room name. The viewer is
// never told which room it is looking at, so a guest cannot turn a view link
// into a write by calling the ordinary API with the room's slug.
//
// This is a real restriction, not a security boundary: Attic has no accounts,
// so anyone who can reach the server and guess a room name can still write to
// it. The token stops a shared link from being an editing link; it does not
// turn an unauthenticated server into an authenticated one.
function newToken() {
  let t = '';
  for (let i = 0; i < 3; i++) t += Math.random().toString(36).slice(2, 10);
  return t.slice(0, 22);
}

function shareToken(slug) {
  const row = q.getMeta.get(slug);
  if (row && row.view_token) return row.view_token;
  const token = newToken();
  q.setToken.run(slug, nextSeq(), token);
  return token;
}

const DEFAULT_COLUMNS = ['To do', 'Doing', 'Done'];

// Deleting a room is the only action in Attic that can destroy work outright:
// there are no accounts, no audit trail, and anyone who can reach the server can
// do it from one confirm dialog. So it writes the whole room out first. The file
// is plain JSON next to the database — readable, restorable, and obvious enough
// that somebody can rescue a room without this app's help.
const TRASH_DIR = path.join(path.dirname(DB_PATH), 'attic-trash');

function trashRoom(slug) {
  const notes = q.live.all(slug).map(rowToNote);
  const links = q.linksLive.all(slug).map((l) => ({ id: l.id, a: l.a, b: l.b }));
  const meta = wallMeta(slug);

  try {
    fs.mkdirSync(TRASH_DIR, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const file = path.join(TRASH_DIR, slug + '--' + stamp + '.json');
    fs.writeFileSync(file, JSON.stringify({
      wall: slug, deletedAt: new Date().toISOString(), meta, notes, links,
    }, null, 2));
    return file;
  } catch (e) {
    // A read-only data directory should not make a room undeletable, but the
    // caller needs to know the safety net was not there.
    console.error('[attic] could not write the room backup:', e.message);
    return null;
  }
}

function listTrash() {
  try {
    return fs.readdirSync(TRASH_DIR)
      .filter((f) => f.slice(-5) === '.json')
      .map((f) => {
        try {
          const d = JSON.parse(fs.readFileSync(path.join(TRASH_DIR, f), 'utf8'));
          return {
            file: f,
            wall: d.wall,
            title: (d.meta && d.meta.title) || '',
            deletedAt: d.deletedAt,
            notes: (d.notes || []).length,
          };
        } catch (e) {
          return null;
        }
      })
      .filter(Boolean)
      .sort((a, b) => String(b.deletedAt).localeCompare(String(a.deletedAt)));
  } catch (e) {
    return [];
  }
}

// Board geometry, mirroring the client's. Only used when converting a room
// between layouts, so a board turned back into a free wall keeps the shape it
// had on screen.
const COL_W = 300;
const COL_GAP = 22;
const BOARD_PAD = 40;
const LANE_HEAD = 54;
const CARD_GAP = 12;
const CARD_INSET = 12;

// Switching a room to columns used to leave every note with an empty column,
// which the client shows as "everything in the first column, in no order" —
// throwing away an arrangement somebody may have spent real time on.
//
// People arrange a free wall in rough columns long before they ask for a board.
// So read the arrangement that is already there: split notes into columns by
// where they sit horizontally, and order them by how far down they are.
function convertToColumns(slug, columns) {
  const notes = q.live.all(slug).map(rowToNote);
  if (!notes.length || !columns.length) return;

  const xs = notes.map((n) => n.x);
  const min = Math.min(...xs);
  const max = Math.max(...xs);
  const span = Math.max(1, max - min);

  const buckets = columns.map(() => []);
  for (const n of notes) {
    // A wall where every note shares an x collapses to the first column, which
    // is the honest answer: there were no columns to read.
    let i = Math.floor(((n.x - min) / span) * columns.length);
    if (i >= columns.length) i = columns.length - 1;
    if (i < 0) i = 0;
    buckets[i].push(n);
  }

  buckets.forEach((bucket, i) => {
    bucket.sort((a, b) => a.y - b.y || a.seq - b.seq);
    bucket.forEach((n, ord) => {
      n.col = columns[i];
      n.ord = ord;
      n.seq = nextSeq();
      writeNote(n);
    });
  });
}

// The reverse: cards carry no meaningful x/y, so turning a board back into a
// free wall would pile every note at the origin. Give them the coordinates they
// appeared to have, so the wall looks like the board did.
function convertToFreeWall(slug, columns) {
  const notes = q.live.all(slug).map(rowToNote);
  if (!notes.length) return;

  const byColumn = {};
  for (const n of notes) {
    const key = n.col || (columns[0] || '');
    (byColumn[key] = byColumn[key] || []).push(n);
  }

  Object.keys(byColumn).forEach((col) => {
    let i = columns.indexOf(col);
    if (i === -1) i = 0;
    const x = BOARD_PAD + i * (COL_W + COL_GAP) + CARD_INSET;
    let y = LANE_HEAD + CARD_GAP;

    byColumn[col].sort((a, b) => a.ord - b.ord || a.seq - b.seq);
    for (const n of byColumn[col]) {
      n.x = x;
      n.y = y;
      n.w = COL_W - CARD_INSET * 2;
      y += n.h + CARD_GAP;
      n.seq = nextSeq();
      writeNote(n);
    }
  });
}

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
  'connect', 'qr', 'support', 'help', 'v', 'view', 'share',
]);

// Reserved names are rejected here, not only in the router. Accepting them
// would create rooms that exist in the database but that no URL can ever reach,
// because the router resolves those paths to something else.
function cleanWall(v) {
  const s = String(v || '').toLowerCase();
  const slug = WALL_RE.test(s) && !RESERVED.has(s) ? s : DEFAULT_WALL;
  return followAlias(slug);
}

// Renames leave a forwarding address behind. Followed with a hop limit so a
// rename cycle (A -> B, later B -> A) cannot spin forever.
function followAlias(slug) {
  let cur = slug;
  for (let i = 0; i < 5; i++) {
    const row = q.alias.get(cur);
    if (!row || row.wall === cur) return cur;
    cur = row.wall;
  }
  return cur;
}

// Turns "Kitchen Ideas!" into "kitchen-ideas". The address people type should
// look like what they called the room.
function slugify(title) {
  let s = String(title || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48)
    .replace(/-+$/g, '');
  if (!s || !WALL_RE.test(s) || RESERVED.has(s)) return '';
  return s;
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
    kind: KINDS.indexOf(input.kind) === -1 ? 'note' : input.kind,
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
  q.upsert.run(n.id, n.wall, n.x, n.y, n.w, n.h, n.text, n.color, n.author,
               n.col, n.ord, n.kind || 'note', n.seq);
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
    kind: r.kind || 'note',
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
      links: (since < 0 ? q.linksLive.all(wallId) : q.linksSince.all(wallId, since))
        .map((l) => ({ id: l.id, a: l.a, b: l.b, deleted: !!l.deleted })),
      peers: livePeers(me, wallId),
      wall: { w: WALL_W, h: WALL_H },
      colors: COLORS,
      kinds: KINDS,
      columnPresets: DEFAULT_COLUMNS,
    });
    return;
  }

  // Mint (or return) the read-only link for a room.
  if (p === '/api/wall/share' && req.method === 'POST') {
    readBody(req, (raw) => {
      const input = parseBody(raw, req.headers['content-type']);
      const wallId = cleanWall(input.wall);
      const token = shareToken(wallId);
      sendJSON(res, 200, { ok: true, token, url: '/v/' + token });
    });
    return;
  }

  // The read-only counterpart of /api/state. Takes no presence heartbeat: a
  // viewer is a spectator, not a peer.
  //
  // Addressed either by room (/kitchen/view — short enough to say out loud) or
  // by token (/v/<token> — when the room name itself should not travel with the
  // link). Reads were never restricted anyway; what this endpoint does is serve
  // a client that cannot write.
  if (p === '/api/view' && req.method === 'GET') {
    const token = String(u.searchParams.get('token') || '');
    let slug;

    if (token) {
      const row = q.byToken.get(token);
      if (!row) {
        sendJSON(res, 404, { ok: false, error: 'unknown or revoked share link' });
        return;
      }
      slug = row.wall;
    } else {
      slug = cleanWall(u.searchParams.get('wall'));
    }

    const since = clampInt(u.searchParams.get('since'), -1, 2 ** 31, -1);
    const meta = wallMeta(slug);

    sendJSON(res, 200, {
      seq: q.getSeq.get().v,
      full: since < 0,
      readOnly: true,
      // Name and layout. The address is withheld only for token links, where
      // the whole point is that the room name does not travel with the link —
      // every note carries its room in the ordinary API, so it has to come off
      // here or the payload hands back what the token withheld. For /<room>/view
      // the slug is already in the URL and there is nothing to hide.
      meta: { title: meta.title, layout: meta.layout, columns: meta.columns },
      notes: (since < 0 ? q.live.all(slug) : q.since.all(slug, since)).map((r) => {
        const n = rowToNote(r);
        if (token) delete n.wall;
        return n;
      }),
      links: (since < 0 ? q.linksLive.all(slug) : q.linksSince.all(slug, since))
        .map((l) => ({ id: l.id, a: l.a, b: l.b, deleted: !!l.deleted })),
      peers: [],
      wall: { w: WALL_W, h: WALL_H },
      colors: COLORS,
    });
    return;
  }

  // Rename a room, address and all. Naming a room "Kitchen Ideas" should put it
  // at /kitchen-ideas — a display name that leaves the URL as /main is a name
  // only half applied.
  if (p === '/api/wall/rename' && req.method === 'POST') {
    readBody(req, (raw) => {
      const input = parseBody(raw, req.headers['content-type']);
      const from = cleanWall(input.wall);
      const title = String(input.title || '').slice(0, 60);

      let target = slugify(title);
      if (!target) {
        // Nothing usable to build an address from — keep the address, set the
        // title, and say so rather than silently moving the room to junk.
        const meta = saveMeta(from, { title });
        sendJSON(res, 200, { ok: true, moved: false, wall: from, meta,
          note: 'kept the current address' });
        return;
      }

      if (target === from) {
        sendJSON(res, 200, { ok: true, moved: false, wall: from,
          meta: saveMeta(from, { title }) });
        return;
      }

      // Never merge into a room that already has something in it.
      let candidate = target;
      let n = 2;
      while ((q.countLive.get(candidate).n > 0 || q.getMeta.get(candidate)) && n < 50) {
        candidate = target + '-' + n;
        n++;
      }

      q.moveNotes.run(candidate, from);
      q.moveLinks.run(candidate, from);
      if (q.getMeta.get(from)) q.moveMeta.run(candidate, from);

      // Any address that already forwarded to the old name follows the room
      // forward too, so a chain of renames stays one hop deep.
      q.repointAliases.run(candidate, from);
      // The address just vacated forwards to the new one.
      q.addAlias.run(from, candidate);
      // The new address is a real room now, so it must not also be a forward.
      q.clearAlias.run(candidate);

      const meta = saveMeta(candidate, { title });
      sendJSON(res, 200, {
        ok: true,
        moved: true,
        wall: candidate,
        url: candidate === DEFAULT_WALL ? '/' : '/' + candidate,
        renamedFrom: from,
        meta,
      });
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

      // Captured before the write: converting back to a free wall needs the
      // columns the board actually had, not whatever it has after saving.
      const before = wallMeta(wallId);
      const meta = saveMeta(wallId, {
        title: input.title,
        layout: input.layout,
        columns,
      });

      // Only on an actual change of layout. Re-running this on a rename would
      // reshuffle a board somebody had already arranged by hand.
      if (before.layout !== meta.layout) {
        if (meta.layout === 'kanban') {
          convertToColumns(wallId, meta.columns.length ? meta.columns : DEFAULT_COLUMNS);
        } else {
          convertToFreeWall(wallId, before.columns.length ? before.columns : DEFAULT_COLUMNS);
        }
      }

      sendJSON(res, 200, {
        ok: true,
        meta,
        converted: before.layout !== meta.layout,
        wasLayout: before.layout,
      });
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
      // Write the room out before touching it. This is the only action here
      // that destroys work outright, and it is one confirm dialog deep.
      const backup = trashRoom(wallId);
      q.dropNotes.run(wallId);
      q.dropLinks.run(wallId);
      q.dropMeta.run(wallId);
      // Forwarding addresses to a room that no longer exists would resurrect it
      // as an empty room on the next visit.
      q.dropAliasesTo.run(wallId);
      for (const [id, peer] of peers) if (peer.wall === wallId) peers.delete(id);
      sendJSON(res, 200, {
        ok: true, wall: wallId, removed, seq: nextSeq(),
        backup: backup ? path.basename(backup) : null,
        backupPath: backup,
      });
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
      const wallId = cleanWall(input.wall);
      const seq = nextSeq();
      q.softDelete.run(seq, id, wallId);
      q.linksForNote.run(nextSeq(), wallId, id, id);
      sendJSON(res, 200, { ok: true, seq });
    });
    return;
  }

  // Undo for a deleted note. Notes are tombstoned rather than removed, so this
  // is just flipping the flag back — and bringing along the connections that
  // were only deleted because this note was.
  if (p === '/api/note/restore' && req.method === 'POST') {
    readBody(req, (raw) => {
      const input = parseBody(raw, req.headers['content-type']);
      const id = String(input.id || '');
      const wallId = cleanWall(input.wall);

      if (!q.deadNote.get(id, wallId)) {
        sendJSON(res, 404, { ok: false, error: 'no deleted note with that id here' });
        return;
      }

      const seq = nextSeq();
      q.restoreNote.run(seq, id, wallId);

      // Only links whose other end is still alive: restoring a line to a note
      // that is itself deleted would put back a line to nothing.
      let links = 0;
      for (const l of q.deadLinksFor.all(wallId, id, id)) {
        const other = l.a === id ? l.b : l.a;
        if (!q.noteAlive.get(other, wallId)) continue;
        q.restoreLink.run(nextSeq(), l.id);
        links++;
      }

      sendJSON(res, 200, { ok: true, id, links, seq });
    });
    return;
  }

  if (p === '/api/link' && req.method === 'POST') {
    readBody(req, (raw) => {
      const input = parseBody(raw, req.headers['content-type']);
      const wallId = cleanWall(input.wall);
      const a = String(input.a || '').slice(0, 64);
      const b = String(input.b || '').slice(0, 64);

      if (!a || !b || a === b) {
        sendJSON(res, 400, { ok: false, error: 'a link needs two different notes' });
        return;
      }
      // Links have no direction, so A-B and B-A are the same link.
      const dupe = q.linkExists.get(wallId, a, b, b, a);
      if (dupe) {
        sendJSON(res, 200, { ok: true, id: dupe.id, existing: true });
        return;
      }

      const seq = nextSeq();
      const id = 'l' + seq + '-' + Math.floor(Math.random() * 1e6);
      q.linkInsert.run(id, wallId, a, b, seq);
      sendJSON(res, 200, { ok: true, id, seq });
    });
    return;
  }

  if (p === '/api/link/delete' && req.method === 'POST') {
    readBody(req, (raw) => {
      const input = parseBody(raw, req.headers['content-type']);
      const seq = nextSeq();
      q.linkDelete.run(seq, String(input.id || ''), cleanWall(input.wall));
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

  // Everything you would want to quote in a bug report, in one place.
  if (p === '/api/about' && req.method === 'GET') {
    sendJSON(res, 200, {
      version: VERSION,
      port: PORT,
      host: HOST,
      addresses: lanAddresses(),
      database: DB_PATH,
      // Only the desktop app has a settings file; the server takes env vars.
      settingsPath: process.env.ATTIC_SETTINGS || null,
      desktop: !!process.env.ATTIC_SETTINGS,
      node: process.versions.node,
      walls: q.walls.all().length,
      notes: q.countAll.get().n,
      startedAt: STARTED_AT,
    });
    return;
  }

  if (p === '/api/trash' && req.method === 'GET') {
    sendJSON(res, 200, { dir: TRASH_DIR, rooms: listTrash() });
    return;
  }

  // Put a deleted room back. Restores under its own name when that is free, and
  // under a suffixed one when it is not — quietly merging into whatever now
  // lives at that address would be worse than an extra room.
  if (p === '/api/wall/restore' && req.method === 'POST') {
    readBody(req, (raw) => {
      const input = parseBody(raw, req.headers['content-type']);
      const file = path.basename(String(input.file || ''));
      let data;
      try {
        data = JSON.parse(fs.readFileSync(path.join(TRASH_DIR, file), 'utf8'));
      } catch (e) {
        sendJSON(res, 404, { ok: false, error: 'no such backup' });
        return;
      }

      let slug = cleanWall(data.wall);
      let n = 2;
      while ((q.countLive.get(slug).n > 0 || q.getMeta.get(slug)) && n < 50) {
        slug = cleanWall(data.wall) + '-' + n;
        n++;
      }

      for (const note of data.notes || []) {
        writeNote(normalizeNote(note, nextSeq(), slug));
      }
      for (const l of data.links || []) {
        const seq = nextSeq();
        q.linkInsert.run('l' + seq + '-' + Math.floor(Math.random() * 1e6), slug, l.a, l.b, seq);
      }
      if (data.meta) {
        saveMeta(slug, {
          title: data.meta.title,
          layout: data.meta.layout,
          columns: data.meta.columns,
        });
      }

      sendJSON(res, 200, {
        ok: true, wall: slug, url: slug === DEFAULT_WALL ? '/' : '/' + slug,
        notes: (data.notes || []).length,
        renamed: slug !== cleanWall(data.wall),
      });
    });
    return;
  }

  if (p === '/api/health') {
    sendJSON(res, 200, {
      ok: true,
      version: VERSION,
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
  // Read-only views. /view is the default room, /<room>/view is any other, and
  // /v/<token> is the form that keeps the room name out of the link.
  if (p === '/view' || p === '/view/' ||
      /^\/[a-z0-9][a-z0-9-]{0,47}\/view\/?$/.test(p) ||
      /^\/v\/[a-z0-9]{6,32}\/?$/.test(p)) {
    serveStatic(res, '/index.html');
    return;
  }

  const bare = p.match(/^\/([a-z0-9][a-z0-9-]{0,47})\/?$/);
  const aliased = p.match(/^\/w\/([a-z0-9][a-z0-9-]{0,47})\/?$/);
  if (aliased || (bare && bare[1].indexOf('.') === -1 && !RESERVED.has(bare[1]))) {
    serveStatic(res, '/index.html');
    return;
  }

  serveStatic(res, p);
});

const STARTED_AT = new Date().toISOString();

server.listen(PORT, HOST, () => {
  console.log('Attic ' + VERSION + ' listening on http://' + HOST + ':' + PORT);
  console.log('  wall      ->  /');
  console.log('  room      ->  /<room-name>');
  console.log('  connect   ->  /connect   (QR codes for other devices)');
  console.log('  display   ->  /?kiosk=1  (wall-mounted tablet mode)');
  console.log('  basic     ->  /legacy    (no JS, for very old browsers)');
  console.log('  database  ->  ' + DB_PATH);

  // Said out loud on every start, because "no auth" is easy to forget once it
  // has been working quietly on a trusted network for a month.
  if (HOST === '0.0.0.0' || HOST === '::') {
    console.log('');
    console.log('  Note: no authentication. Anyone who can reach this port can');
    console.log('  read and edit every room. Keep it on your LAN or behind a VPN.');
  }
});
