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

    console.log('links between notes');
    await post('/api/note', { id: 'la', wall: 'link-wall', x: 10, y: 10, text: 'A' });
    await post('/api/note', { id: 'lb', wall: 'link-wall', x: 300, y: 10, text: 'B' });
    const link = await post('/api/link', { wall: 'link-wall', a: 'la', b: 'lb' });
    check('two notes can be linked', link.body.ok === true && !!link.body.id);

    const linkState = await get('/api/state?since=-1&wall=link-wall&id=smoke');
    check('the link comes back with the wall', linkState.body.links.length === 1);

    const dupe = await post('/api/link', { wall: 'link-wall', a: 'lb', b: 'la' });
    check('a link has no direction, so B-A is the same link',
      dupe.body.existing === true && dupe.body.id === link.body.id);

    const self = await post('/api/link', { wall: 'link-wall', a: 'la', b: 'la' });
    check('a note cannot link to itself', self.status === 400);

    // A line to a note that no longer exists is worse than no line.
    await post('/api/note/delete', { id: 'lb', wall: 'link-wall' });
    const afterNoteGone = await get('/api/state?since=-1&wall=link-wall&id=smoke');
    check('deleting a note removes its links', afterNoteGone.body.links.length === 0);

    await post('/api/note', { id: 'lc', wall: 'link-wall', x: 500, y: 10, text: 'C' });
    const link2 = await post('/api/link', { wall: 'link-wall', a: 'la', b: 'lc' });
    await post('/api/link/delete', { wall: 'link-wall', id: link2.body.id });
    const afterUnlink = await get('/api/state?since=-1&wall=link-wall&id=smoke');
    check('a link can be removed on its own', afterUnlink.body.links.length === 0);
    check('removing a link leaves both notes alone',
      afterUnlink.body.notes.filter((n) => !n.deleted).length === 2);

    console.log('converting a free wall to columns');
    // Three visual groups, the way somebody actually arranges a wall before
    // deciding they want a board.
    const placed = [
      ['ca', 200, 150, 'left top'], ['cb', 220, 400, 'left bottom'],
      ['cc', 700, 180, 'mid top'], ['cd', 720, 430, 'mid bottom'],
      ['ce', 1200, 200, 'right top'], ['cf', 1230, 520, 'right bottom'],
    ];
    for (const [id, x, y, text] of placed) {
      await post('/api/note', { id, wall: 'conv-wall', x, y, text });
    }

    const toBoard = await post('/api/wall',
      { wall: 'conv-wall', layout: 'kanban', columns: ['To do', 'Doing', 'Done'] });
    check('switching layout reports a conversion', toBoard.body.converted === true);

    const converted = await get('/api/state?since=-1&wall=conv-wall&id=smoke');
    const inCol = (c) => converted.body.notes.filter((n) => n.col === c)
      .sort((a, b) => a.ord - b.ord).map((n) => n.text);

    check('no note is left without a column',
      converted.body.notes.every((n) => n.col !== ''));
    check('the left group becomes the first column',
      inCol('To do').join(',') === 'left top,left bottom', inCol('To do').join(','));
    check('the middle group becomes the second column',
      inCol('Doing').join(',') === 'mid top,mid bottom', inCol('Doing').join(','));
    check('the right group becomes the third column',
      inCol('Done').join(',') === 'right top,right bottom', inCol('Done').join(','));

    // Cards carry no meaningful x/y, so going back must not pile them at 0,0.
    const toFree = await post('/api/wall', { wall: 'conv-wall', layout: 'free' });
    check('switching back reports a conversion', toFree.body.converted === true);
    const freed = await get('/api/state?since=-1&wall=conv-wall&id=smoke');
    check('notes get real coordinates back, not the origin',
      freed.body.notes.every((n) => n.x > 0 || n.y > 0));
    check('the columns are still readable as columns',
      new Set(freed.body.notes.map((n) => n.x)).size === 3);

    // A rename must not reshuffle a board somebody arranged by hand.
    await post('/api/wall', { wall: 'conv-wall', layout: 'kanban' });
    const beforeRename = await get('/api/state?since=-1&wall=conv-wall&id=smoke');
    await post('/api/wall', { wall: 'conv-wall', title: 'Still The Same Board' });
    const afterRename = await get('/api/state?since=-1&wall=conv-wall&id=smoke');
    const sig = (r) => r.body.notes.map((n) => n.id + ':' + n.col + ':' + n.ord).sort().join('|');
    check('setting a title leaves the arrangement alone', sig(beforeRename) === sig(afterRename));

    console.log('widgets are notes with a kind');
    const clock = await post('/api/note',
      { id: 'wclock', wall: 'widget-wall', x: 40, y: 40, w: 260, h: 150, kind: 'clock' });
    check('a widget stores its kind', clock.body.note.kind === 'clock');

    // Anything not on the list falls back to a plain note rather than rendering
    // as nothing — an unknown kind must not produce an invisible object.
    const bogus = await post('/api/note',
      { id: 'wbogus', wall: 'widget-wall', x: 10, y: 10, kind: 'weather-api' });
    check('an unrecognised kind falls back to a note', bogus.body.note.kind === 'note');

    const plain = await post('/api/note',
      { id: 'wplain', wall: 'widget-wall', x: 300, y: 40, text: 'ordinary' });
    check('notes without a kind stay notes', plain.body.note.kind === 'note');

    const widgetWall = await get('/api/state?since=-1&wall=widget-wall&id=smoke');
    check('kind survives a round trip',
      widgetWall.body.notes.find((n) => n.id === 'wclock').kind === 'clock');
    check('the client is told which kinds exist',
      Array.isArray(widgetWall.body.kinds) && widgetWall.body.kinds.indexOf('countdown') !== -1);

    // Widgets must inherit everything notes get, since that is the whole reason
    // they are notes.
    await post('/api/note/delete', { id: 'wclock', wall: 'widget-wall' });
    const undoW = await post('/api/note/restore', { id: 'wclock', wall: 'widget-wall' });
    check('a widget can be deleted and undone like any note', undoW.body.ok === true);
    const backW = await get('/api/state?since=-1&wall=widget-wall&id=smoke');
    check('and comes back still a clock',
      backW.body.notes.find((n) => n.id === 'wclock' && !n.deleted).kind === 'clock');

    for (const kind of ['checklist', 'table', 'heading', 'tally', 'calendar']) {
      const w = await post('/api/note',
        { id: 'w-' + kind, wall: 'widget-wall', x: 10, y: 10, kind });
      check(kind + ' is an accepted kind', w.body.note.kind === kind);
    }

    // A checklist and a table are plain text, which is what keeps them
    // editable, greppable, and readable in a room backup.
    const list = await post('/api/note', {
      id: 'wlist', wall: 'widget-wall', x: 10, y: 10, kind: 'checklist',
      text: ['Milk', 'x Rice'].join('\n'),
    });
    check('a checklist stores its items as plain text',
      list.body.note.text.indexOf('x Rice') !== -1);

    const cal = await post('/api/note', {
      id: 'wcal', wall: 'widget-wall', x: 10, y: 10, kind: 'calendar',
      text: ['5 Bin day', '19 Dentist'].join(String.fromCharCode(10)),
    });
    check('a calendar keeps its marked days as plain text',
      cal.body.note.kind === 'calendar' && cal.body.note.text.indexOf('5 Bin day') !== -1);

    console.log('nothing is lost by accident');
    await post('/api/note', { id: 'ua', wall: 'undo-wall', x: 10, y: 10, text: 'note A' });
    await post('/api/note', { id: 'ub', wall: 'undo-wall', x: 300, y: 10, text: 'note B' });
    await post('/api/link', { wall: 'undo-wall', a: 'ua', b: 'ub' });

    await post('/api/note/delete', { id: 'ub', wall: 'undo-wall' });
    const gone = await get('/api/state?since=-1&wall=undo-wall&id=smoke');
    check('deleting a note takes its links with it',
      gone.body.notes.filter((n) => !n.deleted).length === 1 && gone.body.links.length === 0);

    const undo = await post('/api/note/restore', { id: 'ub', wall: 'undo-wall' });
    check('a deleted note can be restored', undo.body.ok === true);
    check('its links come back too', undo.body.links === 1);
    const back = await get('/api/state?since=-1&wall=undo-wall&id=smoke');
    check('the note and the link are both live again',
      back.body.notes.filter((n) => !n.deleted).length === 2 && back.body.links.length === 1);

    // A line to a note that is still deleted must not be revived.
    await post('/api/note/delete', { id: 'ua', wall: 'undo-wall' });
    await post('/api/note/delete', { id: 'ub', wall: 'undo-wall' });
    const one = await post('/api/note/restore', { id: 'ub', wall: 'undo-wall' });
    check('a link is not revived while its other end is deleted', one.body.links === 0);

    const missing = await post('/api/note/restore', { id: 'never-existed', wall: 'undo-wall' });
    check('restoring something that was never deleted is refused', missing.status === 404);

    console.log('deleting a room keeps a copy');
    await post('/api/note', { id: 'ra1', wall: 'trash-wall', x: 10, y: 10, text: 'do not lose me' });
    await post('/api/wall', { wall: 'trash-wall', title: 'Precious' });
    const binned = await post('/api/wall/delete', { wall: 'trash-wall' });
    check('deleting a room writes a backup first', !!binned.body.backup, String(binned.body.backup));

    const trash = await get('/api/trash');
    const entry = trash.body.rooms.find((r) => r.wall === 'trash-wall');
    check('the backup is listed', !!entry && entry.notes === 1 && entry.title === 'Precious');

    const restored = await post('/api/wall/restore', { file: entry.file });
    check('a deleted room can be restored', restored.body.ok === true && restored.body.notes === 1);
    const room = await get('/api/state?since=-1&wall=trash-wall&id=smoke');
    check('its notes and name survive the round trip',
      room.body.meta.title === 'Precious' &&
      room.body.notes.some((n) => n.text === 'do not lose me'));

    // Restoring on top of a room that now has content would merge two
    // unrelated walls, which is worse than an extra room.
    const second = await post('/api/wall/restore', { file: entry.file });
    check('restoring twice does not merge into the live room',
      second.body.renamed === true && second.body.wall !== 'trash-wall', second.body.wall);

    console.log('read-only share links');
    await post('/api/note', { id: 'sa', wall: 'share-wall', x: 20, y: 20, text: 'shared note' });
    await post('/api/wall', { wall: 'share-wall', title: 'Shared Wall' });
    const share = await post('/api/wall/share', { wall: 'share-wall' });
    check('a room can mint a share link', share.body.ok === true && !!share.body.token);
    check('the share link points at /v/', share.body.url === '/v/' + share.body.token);

    const again = await post('/api/wall/share', { wall: 'share-wall' });
    check('the share link is stable across calls', again.body.token === share.body.token);

    const view = await get('/api/view?token=' + share.body.token + '&since=-1');
    check('the view endpoint serves the wall', view.body.readOnly === true &&
      view.body.notes.some((n) => n.text === 'shared note'));
    check('the view keeps the room name', view.body.meta.title === 'Shared Wall');

    // The whole point of the token: a viewer must not learn the room's address,
    // or it could just call the ordinary write API with it.
    const payload = JSON.stringify(view.body);
    check('the view never reveals the room address', payload.indexOf('share-wall') === -1);
    check('notes carry no room field in the view',
      view.body.notes.every((n) => n.wall === undefined));

    const badToken = await fetch(BASE + '/api/view?token=notarealtokenxx');
    check('an unknown share link is refused', badToken.status === 404);

    const viewPage = await fetch(BASE + '/v/' + share.body.token);
    check('the token share URL serves the app', viewPage.status === 200);

    // The short form: /<room>/view, and bare /view for the default room.
    check('a room view URL serves the app',
      (await fetch(BASE + '/share-wall/view')).status === 200);
    check('the bare view URL serves the app', (await fetch(BASE + '/view')).status === 200);

    const byRoom = await get('/api/view?wall=share-wall&since=-1');
    check('the view endpoint works by room name', byRoom.body.readOnly === true &&
      byRoom.body.notes.some((n) => n.text === 'shared note'));
    check('the short form keeps the room name it already shows',
      byRoom.body.notes.every((n) => n.wall === 'share-wall'));

    // Reserved names must be rejected at the API too, or they create rooms that
    // exist in the database but that no URL can ever route to.
    const reserved = await get('/api/state?since=-1&wall=view&id=smoke');
    check('a reserved name cannot become a room', reserved.body.wallId === 'main');

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

    console.log('renaming moves the address');
    await post('/api/note', { id: 'ra', wall: 'old-room', x: 5, y: 5, text: 'travels along' });
    const ren = await post('/api/wall/rename', { wall: 'old-room', title: 'Kitchen Ideas' });
    check('a rename derives the address from the name',
      ren.body.moved === true && ren.body.wall === 'kitchen-ideas', ren.body.wall);

    const relocated = await get('/api/state?since=-1&wall=kitchen-ideas&id=smoke');
    check('notes travel with the room', relocated.body.notes.some((n) => n.id === 'ra'));
    check('the name is kept alongside the address', relocated.body.meta.title === 'Kitchen Ideas');

    // A tablet on a wall is still pointing at the old address.
    const viaOld = await get('/api/state?since=-1&wall=old-room&id=smoke');
    check('the old address forwards to the new one', viaOld.body.wallId === 'kitchen-ideas');

    await post('/api/wall/rename', { wall: 'kitchen-ideas', title: 'Family Board' });
    const viaOldest = await get('/api/state?since=-1&wall=old-room&id=smoke');
    check('a chain of renames still resolves in one hop',
      viaOldest.body.wallId === 'family-board', viaOldest.body.wallId);

    const junk = await post('/api/wall/rename', { wall: 'family-board', title: '!!!' });
    check('a name with no usable letters keeps the address',
      junk.body.moved === false && junk.body.wall === 'family-board');

    await post('/api/note', { id: 'rb', wall: 'taken-name', x: 5, y: 5, text: 'sitting here' });
    await post('/api/note', { id: 'rc', wall: 'other-room', x: 5, y: 5, text: 'renaming me' });
    const clash = await post('/api/wall/rename', { wall: 'other-room', title: 'Taken Name' });
    check('renaming never merges into an occupied address',
      clash.body.wall === 'taken-name-2', clash.body.wall);
    const untouched = await get('/api/state?since=-1&wall=taken-name&id=smoke');
    check('the occupied room is left alone',
      untouched.body.notes.length === 1 && untouched.body.notes[0].id === 'rb');

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
