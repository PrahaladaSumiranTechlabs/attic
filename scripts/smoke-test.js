'use strict';

// Boots the real server on a scratch database and exercises the API.
//
// The point is not coverage, it is a tripwire for the one thing that would
// quietly break everyone: server.js must keep working as a plain Node script,
// independent of the Electron wrapper. CI runs this before every build.

const { spawn } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

const PORT = 8129;
const BASE = 'http://127.0.0.1:' + PORT;
const DB = path.join(os.tmpdir(), 'attic-smoke-' + process.pid + '.db');

let failures = 0;

function check(name, cond, detail) {
  if (cond) {
    console.log('  ok   ' + name);
  } else {
    failures++;
    console.log('  FAIL ' + name + (detail ? '  -> ' + detail : ''));
  }
}

async function get(p) {
  const r = await fetch(BASE + p);
  return { status: r.status, body: await r.json() };
}

async function post(p, payload) {
  const r = await fetch(BASE + p, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  return { status: r.status, body: await r.json() };
}

async function waitForServer(tries = 60) {
  for (let i = 0; i < tries; i++) {
    try {
      const r = await fetch(BASE + '/api/health');
      if (r.ok) return true;
    } catch (e) { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 100));
  }
  return false;
}

(async () => {
  const server = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], {
    env: { ...process.env, PORT: String(PORT), HOST: '127.0.0.1', NOTER_DB: DB },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  let serverErr = '';
  server.stderr.on('data', (d) => { serverErr += d; });

  const cleanup = () => {
    if (!server.killed) server.kill();
    try { fs.unlinkSync(DB); } catch (e) {}
  };

  try {
    if (!(await waitForServer())) {
      console.log('server never became healthy');
      if (serverErr) console.log(serverErr);
      cleanup();
      process.exit(1);
    }

    console.log('health + static');
    const health = await get('/api/health');
    check('health responds', health.body.ok === true);
    check('landing page served', (await fetch(BASE + '/landing')).status === 200);
    check('app served', (await fetch(BASE + '/')).status === 200);
    check('client is served', (await fetch(BASE + '/app.js')).status === 200);

    console.log('notes + delta sync');
    const a = await post('/api/note',
      { id: 'smoke1', x: 10, y: 20, text: 'hello', color: 'blue', wall: 'main' });
    check('note created', a.body.ok === true && a.body.note.text === 'hello');

    const snap = await get('/api/state?since=-1&wall=main&id=smoke');
    check('snapshot contains the note', snap.body.notes.some((n) => n.id === 'smoke1'));

    const afterSeq = a.body.seq;
    const b = await post('/api/note',
      { id: 'smoke2', x: 30, y: 40, text: 'second', wall: 'main' });
    const delta = await get('/api/state?since=' + afterSeq + '&wall=main&id=smoke');
    check('delta returns only what changed',
      delta.body.notes.length === 1 && delta.body.notes[0].id === 'smoke2',
      'got ' + delta.body.notes.length + ' notes');

    console.log('wall isolation');
    await post('/api/note', { id: 'other1', x: 5, y: 5, text: 'elsewhere', wall: 'other-wall' });
    const mainSnap = await get('/api/state?since=-1&wall=main&id=smoke');
    check('other wall is not visible from main',
      !mainSnap.body.notes.some((n) => n.id === 'other1'));
    const otherSnap = await get('/api/state?since=-1&wall=other-wall&id=smoke');
    check('other wall has its own note',
      otherSnap.body.notes.length === 1 && otherSnap.body.notes[0].id === 'other1');

    console.log('deletes');
    await post('/api/note/delete', { id: 'smoke1', wall: 'main' });
    const afterDel = await get('/api/state?since=' + b.body.seq + '&wall=main&id=smoke');
    check('delete propagates as a tombstone',
      afterDel.body.notes.some((n) => n.id === 'smoke1' && n.deleted === true));

    console.log('presence');
    await get('/api/state?since=-1&wall=main&id=peerX&name=tablet&vx=0&vy=0&vw=800&vh=600');
    const seen = await get('/api/state?since=-1&wall=main&id=peerY&name=desk&vx=0&vy=0&vw=800&vh=600');
    check('peers on the same wall see each other',
      seen.body.peers.some((p) => p.id === 'peerX'));
    const otherWallPeers = await get('/api/state?since=-1&wall=other-wall&id=peerZ');
    check('presence does not leak across walls',
      !otherWallPeers.body.peers.some((p) => p.id === 'peerX'));

    console.log('templates');
    const tpls = await get('/api/templates');
    check('templates listed', Array.isArray(tpls.body.templates) && tpls.body.templates.length > 0);
    // Count comes from the template listing rather than a literal, so editing a
    // template does not fail a test that is not about templates' contents.
    const kanbanTpl = tpls.body.templates.find((t) => t.key === 'kanban');
    const seeded = await post('/api/template', { name: 'kanban', wall: 'tpl-wall' });
    check('template seeds notes', seeded.body.ok === true && seeded.body.added === kanbanTpl.count,
      'added ' + seeded.body.added + ', template declares ' + kanbanTpl.count);
    const tplSnap = await get('/api/state?since=-1&wall=tpl-wall&id=smoke');
    check('seeded notes landed on the right wall', tplSnap.body.notes.length === kanbanTpl.count);

    console.log('room names and layout');
    const named = await post('/api/wall', { wall: 'named-room', title: 'Kitchen Ideas' });
    check('a room can be given a display name', named.body.meta.title === 'Kitchen Ideas');
    const namedState = await get('/api/state?since=-1&wall=named-room&id=smoke');
    check('the name comes back with the room', namedState.body.meta.title === 'Kitchen Ideas');
    check('naming a room does not change its address', namedState.body.wallId === 'named-room');

    const cols = await post('/api/wall',
      { wall: 'named-room', layout: 'kanban', columns: ['Backlog', 'Doing', 'Shipped'] });
    check('columns are customisable', cols.body.meta.columns.join(',') === 'Backlog,Doing,Shipped');
    check('layout switches to a board', cols.body.meta.layout === 'kanban');

    console.log('kanban is structural');
    const board = await post('/api/template', { name: 'kanban', wall: 'board-wall' });
    check('the kanban template sets the layout', board.body.meta.layout === 'kanban');
    check('the kanban template defines columns',
      board.body.meta.columns.join(',') === 'To do,Doing,Done');
    const boardState = await get('/api/state?since=-1&wall=board-wall&id=smoke');
    check('cards carry a column, not coordinates',
      boardState.body.notes.every((n) => n.col !== ''));
    check('cards carry an order within the column',
      boardState.body.notes.filter((n) => n.col === 'To do').map((n) => n.ord).sort().join(',') === '0,1');

    await post('/api/note',
      { id: 'moved', wall: 'board-wall', x: 0, y: 0, text: 'move me', col: 'Done', ord: 0 });
    const afterMove = await get('/api/state?since=-1&wall=board-wall&id=smoke');
    const moved = afterMove.body.notes.find((n) => n.id === 'moved');
    check('a card can be placed in a column', moved && moved.col === 'Done' && moved.ord === 0);

    console.log('deleting a room');
    const before = await get('/api/state?since=-1&wall=board-wall&id=smoke');
    check('room has content before deletion', before.body.notes.length > 0);
    const del = await post('/api/wall/delete', { wall: 'board-wall' });
    check('delete reports what it removed', del.body.ok === true && del.body.removed > 0);
    const after = await get('/api/state?since=-1&wall=board-wall&id=smoke');
    check('room is empty after deletion', after.body.notes.length === 0);
    check('room config is gone too', after.body.meta.layout === 'free' &&
      after.body.meta.columns.length === 0);
    const wallList = await get('/api/walls');
    check('deleted room disappears from the room list',
      !wallList.body.walls.some((w) => w.wall === 'board-wall'));
    check('other rooms survive the deletion',
      wallList.body.walls.some((w) => w.wall === 'named-room'));

    console.log('new wall slugs');
    const nw = await post('/api/wall/new', {});
    check('slug is url-safe and memorable', /^[a-z]+-[a-z]+-\d{3}$/.test(nw.body.wall), nw.body.wall);

    console.log('no-JS fallback');
    const legacy = await fetch(BASE + '/legacy?w=main');
    const legacyHTML = await legacy.text();
    check('legacy page renders', legacy.status === 200 && legacyHTML.indexOf('<form') !== -1);
    check('legacy page needs no JavaScript', legacyHTML.indexOf('<script') === -1);
  } catch (err) {
    failures++;
    console.log('threw: ' + (err && err.stack ? err.stack : err));
  }

  cleanup();

  console.log('');
  if (failures) {
    console.log(failures + ' check(s) failed');
    process.exit(1);
  }
  console.log('all checks passed');
})();
