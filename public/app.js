/* Attic — deliberately ES5. No build step, no transpiler, no framework.
   Everything here is chosen to run on a 2010-2014 tablet browser:
     - XMLHttpRequest polling, not WebSocket
     - absolutely positioned divs and a CSS transform, not a <canvas>
     - touch + mouse events, not pointer events
   If you find yourself reaching for a modern API here, don't. */

(function () {
  'use strict';

  var POLL_MS = 1500;
  // E-paper panels refresh in 120-450ms and ghost badly. Polling at the normal
  // rate would leave the screen in a permanent refresh loop, so e-ink mode
  // trades latency for legibility.
  var POLL_MS_EINK = 8000;
  var NOTE_W = 180;
  var NOTE_H = 180;
  var MIN_NOTE = 90;
  var MAX_NOTE = 600;
  var ZOOMS = [0.2, 0.3, 0.45, 0.6, 0.8, 1, 1.25, 1.6, 2];

  var body = document.body;
  var canvas = document.getElementById('canvas');
  var wall = document.getElementById('wall');
  var statusEl = document.getElementById('status');
  var whoEl = document.getElementById('who');
  var swatchWrap = document.getElementById('swatches');
  var minimap = document.getElementById('minimap');
  var mmInner = document.getElementById('mm-inner');
  var editor = document.getElementById('editor');
  var editorText = document.getElementById('editor-text');
  var overviewBtn = document.getElementById('overview');
  var kioskBtn = document.getElementById('kiosk');
  var einkBtn = document.getElementById('eink');
  var zoomLabel = document.getElementById('zoomlevel');

  var notes = {};      // id -> note data
  var els = {};        // id -> DOM element
  var seq = -1;        // last server sequence we have applied
  var wallW = 4000;
  var wallH = 3000;
  var colors = ['yellow'];
  var myColor = 'yellow';
  var editingId = null;
  var failures = 0;
  var zoom = 1;
  var fitted = false;  // true when zoom was set by "fit"
  var kioskOn = false;
  var einkOn = false;
  var lastStatus = '';
  var lastMinimap = '';
  var lastZoomLabel = '';

  // The URL is the wall. /w/<slug> names one; bare / is the default wall, which
  // is what a self-hosted box on a home network actually wants.
  // Both /<room> and the longer /w/<room> alias resolve to the same wall.
  var wallId = 'main';
  var m = window.location.pathname.match(/^\/(?:w\/)?([a-z0-9][a-z0-9-]{0,47})\/?$/);
  if (m) wallId = m[1];

  // -------------------------------------------------------------- identity

  function store(key, val) {
    try {
      if (val === undefined) return window.localStorage.getItem(key);
      window.localStorage.setItem(key, val);
      return val;
    } catch (e) {
      // Private mode on old iOS throws on setItem. Fall back to a cookie.
      if (val === undefined) {
        var mm = document.cookie.match(new RegExp('(^|; )' + key + '=([^;]*)'));
        return mm ? decodeURIComponent(mm[2]) : null;
      }
      document.cookie = key + '=' + encodeURIComponent(val) + ';path=/;max-age=31536000';
      return val;
    }
  }

  var myId = store('attic.id');
  if (!myId) {
    myId = 'c' + Math.floor(Math.random() * 1e9).toString(36) + Date.now().toString(36);
    store('attic.id', myId);
  }

  var myName = store('attic.name') || '';
  if (!myName) {
    // Never block first paint with a prompt. A wall-mounted tablet should come
    // up showing the wall; naming is a thing you do once, later, by choice.
    myName = 'device-' + myId.slice(1, 5);
    store('attic.name', myName);
  }

  function showName() { whoEl.innerHTML = 'you: ' + escapeHTML(myName); }
  showName();

  whoEl.onclick = function () {
    var n = window.prompt('Name this device (shows on the wall):', myName);
    if (n) {
      myName = n.slice(0, 40);
      store('attic.name', myName);
      showName();
    }
  };

  // --------------------------------------------------------------- helpers

  function escapeHTML(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;')
      .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  function hasClass(el, c) { return (' ' + el.className + ' ').indexOf(' ' + c + ' ') !== -1; }
  function addClass(el, c) { if (!hasClass(el, c)) el.className += (el.className ? ' ' : '') + c; }
  function removeClass(el, c) {
    el.className = (' ' + el.className + ' ').replace(' ' + c + ' ', ' ').replace(/^ | $/g, '');
  }

  function xhr(method, url, payload, cb) {
    var r = new XMLHttpRequest();
    r.open(method, url, true);
    if (payload) r.setRequestHeader('Content-Type', 'application/json');
    r.onreadystatechange = function () {
      if (r.readyState !== 4) return;
      if (r.status >= 200 && r.status < 300) {
        var data = null;
        try { data = JSON.parse(r.responseText); } catch (e) {}
        cb(null, data);
      } else {
        cb(new Error('http ' + r.status));
      }
    };
    r.send(payload ? JSON.stringify(payload) : null);
  }

  function scrollX() {
    return window.pageXOffset || document.documentElement.scrollLeft || document.body.scrollLeft || 0;
  }
  function scrollY() {
    return window.pageYOffset || document.documentElement.scrollTop || document.body.scrollTop || 0;
  }
  function viewW() { return document.documentElement.clientWidth || window.innerWidth; }
  function viewH() { return document.documentElement.clientHeight || window.innerHeight; }

  // Screen pixels and wall coordinates diverge as soon as zoom is not 1. Every
  // conversion goes through these two, so there is one place to be wrong.
  function toWallX(clientX) { return (clientX + scrollX()) / zoom; }
  function toWallY(clientY) { return (clientY + scrollY()) / zoom; }

  function setTransform(el, v) {
    el.style.webkitTransform = v;
    el.style.MozTransform = v;
    el.style.msTransform = v;
    el.style.transform = v;
  }

  // Writing innerHTML unconditionally forces a repaint even when nothing
  // changed. On an LCD that is invisible waste; on e-paper it is a visible
  // flash every cycle. So every live-updating region goes through here.
  function setHTML(el, html, prev) {
    if (html === prev) return prev;
    el.innerHTML = html;
    return html;
  }

  function countNotes() {
    var n = 0;
    for (var k in notes) { if (notes.hasOwnProperty(k)) n++; }
    return n;
  }

  function refreshEmptyState() {
    if (countNotes() === 0) addClass(body, 'is-empty');
    else removeClass(body, 'is-empty');
  }

  // ------------------------------------------------------------ zoom & pan

  function applyZoom() {
    setTransform(wall, zoom === 1 ? '' : 'scale(' + zoom + ')');
    canvas.style.width = Math.round(wallW * zoom) + 'px';
    canvas.style.height = Math.round(wallH * zoom) + 'px';
    lastZoomLabel = setHTML(zoomLabel, Math.round(zoom * 100) + '%', lastZoomLabel);
    if (fitted) addClass(overviewBtn, 'on'); else removeClass(overviewBtn, 'on');
  }

  // Zoom around a fixed screen point, so the thing under the cursor stays under
  // the cursor. Without this, zooming feels like the board is running away.
  function setZoom(z, anchorX, anchorY, isFit) {
    z = Math.max(0.1, Math.min(3, z));
    if (anchorX === undefined) { anchorX = viewW() / 2; anchorY = viewH() / 2; }

    var wx = toWallX(anchorX);
    var wy = toWallY(anchorY);

    zoom = z;
    fitted = !!isFit;
    applyZoom();

    window.scrollTo(
      Math.max(0, Math.round(wx * zoom - anchorX)),
      Math.max(0, Math.round(wy * zoom - anchorY))
    );
  }

  function stepZoom(dir) {
    var i = 0;
    while (i < ZOOMS.length - 1 && ZOOMS[i] < zoom - 0.001) i++;
    var next = ZOOMS[Math.max(0, Math.min(ZOOMS.length - 1, i + dir))];
    setZoom(next);
  }

  document.getElementById('zoomin').onclick = function () { stepZoom(1); };
  document.getElementById('zoomout').onclick = function () { stepZoom(-1); };

  overviewBtn.onclick = function () {
    if (fitted) { setZoom(1); return; }
    setZoom(Math.min(viewW() / wallW, (viewH() - 56) / wallH), 0, 0, true);
    window.scrollTo(0, 0);
  };

  // Ctrl/Cmd + wheel zooms, plain wheel scrolls. Same convention as every other
  // canvas tool, and it leaves ordinary scrolling alone.
  canvas.addEventListener('wheel', function (e) {
    if (!e.ctrlKey && !e.metaKey) return;
    if (e.preventDefault) e.preventDefault();
    setZoom(zoom * (e.deltaY < 0 ? 1.12 : 1 / 1.12), e.clientX, e.clientY);
  }, false);

  // Drag the empty board to pan. Mouse only: touch devices already scroll by
  // dragging, with momentum we would only make worse.
  (function () {
    var panning = false, sx, sy, ox, oy;

    canvas.addEventListener('mousedown', function (e) {
      if (kioskOn || editingId) return;
      if (e.target !== canvas && e.target !== wall) return; // a note handles its own drag
      panning = true;
      sx = e.clientX; sy = e.clientY;
      ox = scrollX(); oy = scrollY();
      addClass(canvas, 'panning');
      if (e.preventDefault) e.preventDefault();
    }, false);

    document.addEventListener('mousemove', function (e) {
      if (!panning) return;
      window.scrollTo(Math.max(0, ox - (e.clientX - sx)), Math.max(0, oy - (e.clientY - sy)));
    }, false);

    document.addEventListener('mouseup', function () {
      if (!panning) return;
      panning = false;
      removeClass(canvas, 'panning');
    }, false);
  })();

  // ----------------------------------------------------------- note render

  function renderNote(n) {
    var el = els[n.id];
    if (n.deleted) {
      if (el && el.parentNode) el.parentNode.removeChild(el);
      delete els[n.id];
      delete notes[n.id];
      refreshEmptyState();
      return;
    }
    if (!el) {
      el = document.createElement('div');
      el.className = 'note';
      // Body and grip are separate children so re-rendering text never blows
      // away the grip's event handlers.
      var bodyEl = document.createElement('div');
      bodyEl.className = 'note-body';
      var grip = document.createElement('div');
      grip.className = 'note-grip';
      el.appendChild(bodyEl);
      el.appendChild(grip);
      wall.appendChild(el);
      els[n.id] = el;
      attachDrag(el, n.id);
      attachResize(grip, el, n.id);
    }
    notes[n.id] = n;
    el.className = 'note c-' + n.color;
    el.style.left = n.x + 'px';
    el.style.top = n.y + 'px';
    el.style.width = n.w + 'px';
    el.style.height = n.h + 'px';
    el.firstChild.innerHTML = escapeHTML(n.text) +
      (n.author ? '<span class="author">' + escapeHTML(n.author) + '</span>' : '');
    refreshEmptyState();
  }

  function saveNote(n, cb) {
    notes[n.id] = n;
    renderNote(n);
    n.wall = wallId;
    xhr('POST', '/api/note', n, function (err, data) {
      if (!err && data && data.seq) seq = Math.max(seq, data.seq);
      if (cb) cb(err);
    });
  }

  function deleteNote(id) {
    var el = els[id];
    if (el && el.parentNode) el.parentNode.removeChild(el);
    delete els[id];
    delete notes[id];
    refreshEmptyState();
    xhr('POST', '/api/note/delete', { id: id, wall: wallId }, function () {});
  }

  // ------------------------------------------------------------- dragging
  // Manual hit-testing on touch + mouse. HTML5 drag-and-drop does not exist on
  // old mobile Safari, and pointer events are far too new to rely on.

  function attachDrag(el, id) {
    var startX, startY, origX, origY, moved, downAt;

    function down(e) {
      if (editingId || kioskOn) return;
      var t = e.touches ? e.touches[0] : e;
      startX = t.clientX;
      startY = t.clientY;
      origX = notes[id].x;
      origY = notes[id].y;
      moved = false;
      downAt = new Date().getTime();
      addClass(el, 'dragging');

      if (e.touches) {
        document.addEventListener('touchmove', move, false);
        document.addEventListener('touchend', up, false);
      } else {
        document.addEventListener('mousemove', move, false);
        document.addEventListener('mouseup', up, false);
      }
      if (e.stopPropagation) e.stopPropagation();
      if (e.preventDefault) e.preventDefault();
    }

    function move(e) {
      var t = e.touches ? e.touches[0] : e;
      // Screen movement divided by zoom: at 50% the pointer travels twice as
      // far as the note should.
      var dx = (t.clientX - startX) / zoom;
      var dy = (t.clientY - startY) / zoom;
      if (Math.abs(dx) > 4 / zoom || Math.abs(dy) > 4 / zoom) moved = true;
      var nx = Math.max(0, Math.min(wallW - notes[id].w, origX + dx));
      var ny = Math.max(0, Math.min(wallH - notes[id].h, origY + dy));
      notes[id].x = nx;
      notes[id].y = ny;
      el.style.left = nx + 'px';
      el.style.top = ny + 'px';
      if (e.preventDefault) e.preventDefault();
    }

    function up() {
      document.removeEventListener('touchmove', move, false);
      document.removeEventListener('touchend', up, false);
      document.removeEventListener('mousemove', move, false);
      document.removeEventListener('mouseup', up, false);
      removeClass(el, 'dragging');

      if (moved) {
        saveNote(notes[id]);
      } else if (new Date().getTime() - downAt < 700) {
        openEditor(id);
      }
    }

    el.addEventListener('touchstart', down, false);
    el.addEventListener('mousedown', down, false);
  }

  // -------------------------------------------------------------- resizing

  function attachResize(grip, el, id) {
    var startX, startY, origW, origH;

    function down(e) {
      if (editingId || kioskOn) return;
      var t = e.touches ? e.touches[0] : e;
      startX = t.clientX;
      startY = t.clientY;
      origW = notes[id].w;
      origH = notes[id].h;

      if (e.touches) {
        document.addEventListener('touchmove', move, false);
        document.addEventListener('touchend', up, false);
      } else {
        document.addEventListener('mousemove', move, false);
        document.addEventListener('mouseup', up, false);
      }
      // Stop the drag handler on the parent note from also firing.
      if (e.stopPropagation) e.stopPropagation();
      if (e.preventDefault) e.preventDefault();
    }

    function move(e) {
      var t = e.touches ? e.touches[0] : e;
      var nw = Math.max(MIN_NOTE, Math.min(MAX_NOTE, origW + (t.clientX - startX) / zoom));
      var nh = Math.max(MIN_NOTE, Math.min(MAX_NOTE, origH + (t.clientY - startY) / zoom));
      nw = Math.min(nw, wallW - notes[id].x);
      nh = Math.min(nh, wallH - notes[id].y);
      notes[id].w = Math.round(nw);
      notes[id].h = Math.round(nh);
      el.style.width = notes[id].w + 'px';
      el.style.height = notes[id].h + 'px';
      if (e.preventDefault) e.preventDefault();
    }

    function up() {
      document.removeEventListener('touchmove', move, false);
      document.removeEventListener('touchend', up, false);
      document.removeEventListener('mousemove', move, false);
      document.removeEventListener('mouseup', up, false);
      saveNote(notes[id]);
    }

    grip.addEventListener('touchstart', down, false);
    grip.addEventListener('mousedown', down, false);
  }

  // --------------------------------------------------------------- editor

  function openEditor(id) {
    editingId = id;
    editorText.value = notes[id] ? notes[id].text : '';
    editor.className = 'open';
    // Old iOS will not focus a textarea outside a user gesture; this sits
    // inside the touchend handler chain, so it works.
    try { editorText.focus(); } catch (e) {}
  }

  function closeEditor() {
    editingId = null;
    editor.className = '';
  }

  document.getElementById('editor-save').onclick = function () {
    if (!editingId) return;
    var n = notes[editingId];
    n.text = editorText.value;
    n.author = myName;
    saveNote(n);
    closeEditor();
  };

  document.getElementById('editor-cancel').onclick = function () {
    // An untouched blank note is an abandoned note, not a real one.
    if (editingId && notes[editingId] && !notes[editingId].text) deleteNote(editingId);
    closeEditor();
  };

  document.getElementById('editor-del').onclick = function () {
    if (!editingId) return;
    if (window.confirm('Delete this note?')) deleteNote(editingId);
    closeEditor();
  };

  // ------------------------------------------------------------ new notes

  function addNote() {
    // Drop it near the middle of whatever you are currently looking at, with a
    // small jitter so repeated taps do not stack notes perfectly on top.
    var jitter = function () { return Math.floor(Math.random() * 60) - 30; };
    var cx = toWallX(viewW() / 2) - NOTE_W / 2 + jitter();
    var cy = toWallY(viewH() / 2) - NOTE_H / 2 + jitter();
    var n = {
      id: 'n' + Date.now().toString(36) + Math.floor(Math.random() * 1e4).toString(36),
      x: Math.round(Math.max(0, Math.min(wallW - NOTE_W, cx))),
      y: Math.round(Math.max(0, Math.min(wallH - NOTE_H, cy))),
      w: NOTE_W, h: NOTE_H,
      text: '', color: myColor, author: myName
    };
    saveNote(n);
    openEditor(n.id);
  }

  document.getElementById('add').onclick = addNote;
  document.getElementById('kiosk-add').onclick = addNote;

  function buildSwatches() {
    swatchWrap.innerHTML = '';
    for (var i = 0; i < colors.length; i++) {
      (function (c) {
        var s = document.createElement('span');
        s.className = 'swatch c-' + c + (c === myColor ? ' on' : '');
        s.onclick = function () {
          myColor = c;
          store('attic.color', c);
          buildSwatches();
        };
        swatchWrap.appendChild(s);
      })(colors[i]);
    }
  }

  // ------------------------------------------------------------------ walls

  var wallNameEl = document.getElementById('wallname');
  wallNameEl.innerHTML = escapeHTML(wallId);

  function wallPath() { return wallId === 'main' ? '/' : '/' + wallId; }

  // Tapping the room chip answers "what rooms are there?", which is otherwise
  // unanswerable: rooms exist by being visited, so nothing lists them until
  // something asks the server.
  var roombox = document.getElementById('roombox');

  function openRooms() {
    roombox.className = 'open';
    var list = document.getElementById('room-list');
    list.innerHTML = 'loading&hellip;';

    xhr('GET', '/api/walls', null, function (err, data) {
      if (err || !data || !data.walls) {
        list.innerHTML = '<div class="room">could not load the room list</div>';
        return;
      }

      var walls = data.walls.slice();
      // A brand new room has no notes yet, so it will not come back from the
      // server. Show it anyway — you are standing in it.
      var listed = false;
      for (var i = 0; i < walls.length; i++) if (walls[i].wall === wallId) listed = true;
      if (!listed) walls.unshift({ wall: wallId, notes: 0 });

      list.innerHTML = '';
      for (var j = 0; j < walls.length; j++) {
        (function (w) {
          var row = document.createElement('div');
          var here = w.wall === wallId;
          row.className = 'room' + (here ? ' here' : '');
          row.innerHTML = '<span class="count">' + w.notes +
            (w.notes === 1 ? ' note' : ' notes') + '</span>' +
            escapeHTML(w.wall) + (here ? '<span class="tag">you are here</span>' : '');
          if (!here) {
            row.onclick = function () {
              window.location.href = w.wall === 'main' ? '/' : '/' + w.wall;
            };
          }
          list.appendChild(row);
        })(walls[j]);
      }
    });
  }

  wallNameEl.onclick = openRooms;
  document.getElementById('room-close').onclick = function () { roombox.className = ''; };

  function gotoTypedRoom() {
    var raw = document.getElementById('room-name').value || '';
    var name = raw.toLowerCase().replace(/[^a-z0-9-]/g, '-').replace(/^-+|-+$/g, '').slice(0, 48);
    if (!name) return;
    window.location.href = name === 'main' ? '/' : '/' + name;
  }

  document.getElementById('room-open').onclick = gotoTypedRoom;
  document.getElementById('room-name').onkeydown = function (e) {
    if ((e.keyCode || e.which) === 13) gotoTypedRoom();
  };

  // The share overlay shows a QR for this wall on the host's LAN address, not
  // on whatever hostname this browser happens to be using — "localhost" is
  // useless to the tablet you are trying to set up.
  var sharebox = document.getElementById('sharebox');

  document.getElementById('share').onclick = function () {
    var qrBox = document.getElementById('share-qr');
    var urlBox = document.getElementById('share-url');
    sharebox.className = 'open';
    urlBox.innerHTML = 'finding this machine&rsquo;s address&hellip;';
    qrBox.innerHTML = '';

    xhr('GET', '/api/addresses', null, function (err, data) {
      var host = window.location.host;
      if (!err && data && data.addresses && data.addresses.length) {
        host = data.addresses[0].address + ':' + data.port;
      }
      var url = 'http://' + host + wallPath();
      urlBox.innerHTML = escapeHTML(url);
      // Fetched as markup rather than an <img src>, so it inherits the page's
      // colours and stays crisp at any size.
      var r = new XMLHttpRequest();
      r.open('GET', '/api/qr.svg?text=' + encodeURIComponent(url), true);
      r.onreadystatechange = function () {
        if (r.readyState === 4 && r.status === 200) qrBox.innerHTML = r.responseText;
      };
      r.send(null);
    });
  };

  document.getElementById('share-close').onclick = function () { sharebox.className = ''; };

  document.getElementById('newwall').onclick = function () {
    xhr('POST', '/api/wall/new', {}, function (err, data) {
      if (err || !data || !data.url) return;
      window.location.href = data.url;
    });
  };

  // ------------------------------------------------------------- templates
  // Offered only on an empty wall. A template is a seeding action, not a mode:
  // once the notes land there is nothing left holding the layout together, so
  // the board can drift into whatever shape the work actually needs.

  function loadTemplates() {
    var box = document.getElementById('templates');
    if (!box) return;
    xhr('GET', '/api/templates', null, function (err, data) {
      if (err || !data || !data.templates) return;
      box.innerHTML = '';
      for (var i = 0; i < data.templates.length; i++) {
        (function (t) {
          var b = document.createElement('div');
          b.className = 'tpl';
          b.innerHTML = '<b>' + escapeHTML(t.label) + '</b><span>' + escapeHTML(t.blurb) + '</span>';
          b.onclick = function () {
            xhr('POST', '/api/template',
              { name: t.key, author: myName, wall: wallId }, function () {});
          };
          box.appendChild(b);
        })(data.templates[i]);
      }
    });
  }

  // ---------------------------------------------------------- display mode

  var toastEl = null, toastTimer = null;

  function toast(msg, ms) {
    if (!toastEl) {
      toastEl = document.createElement('div');
      toastEl.id = 'toast';
      body.appendChild(toastEl);
    }
    toastEl.innerHTML = escapeHTML(msg);
    toastEl.style.display = 'block';
    if (toastTimer) window.clearTimeout(toastTimer);
    toastTimer = window.setTimeout(function () {
      if (toastEl) toastEl.style.display = 'none';
    }, ms || 5000);
  }

  function setKiosk(on, announce) {
    kioskOn = on;
    if (on) addClass(body, 'kiosk'); else removeClass(body, 'kiosk');
    if (on) addClass(kioskBtn, 'on'); else removeClass(kioskBtn, 'on');
    store('attic.kiosk', on ? '1' : '');
    if (on && announce) toast('Display mode — “exit display”, top left, or press Esc', 6000);
  }

  kioskBtn.onclick = function () { setKiosk(!kioskOn, true); };
  document.getElementById('kiosk-exit').onclick = function () { setKiosk(false); };

  // A keyboard way out, for anything with a keyboard. Esc also closes the
  // editor, so display mode only claims it when no note is open.
  document.onkeydown = function (e) {
    var code = e.keyCode || e.which;
    if (code !== 27) return;
    if (editingId) { closeEditor(); return; }
    if (sharebox && sharebox.className === 'open') { sharebox.className = ''; return; }
    if (roombox && roombox.className === 'open') { roombox.className = ''; return; }
    if (kioskOn) setKiosk(false);
  };

  // ------------------------------------------------------------ e-ink mode
  // For actual e-paper hardware (Boox, Kindle, reMarkable, Kobo), not an LCD
  // imitating the look. Colour becomes border texture, presence goes away, and
  // the poll interval stretches so the panel is not perpetually refreshing.

  function setEink(on) {
    einkOn = on;
    if (on) addClass(body, 'eink'); else removeClass(body, 'eink');
    if (on) addClass(einkBtn, 'on'); else removeClass(einkBtn, 'on');
    store('attic.eink', on ? '1' : '');
    lastStatus = '';
    lastMinimap = '';
  }

  einkBtn.onclick = function () { setEink(!einkOn); };

  // -------------------------------------------------------------- minimap

  function drawMinimap(peers) {
    if (einkOn || kioskOn) return; // hidden in both modes; do not pay to build it
    var mw = minimap.offsetWidth;
    var mh = minimap.offsetHeight;
    var sx = mw / wallW;
    var sy = mh / wallH;
    var html = '';

    // Every note as a dot, so the minimap doubles as a density map of the wall.
    for (var id in notes) {
      if (!notes.hasOwnProperty(id)) continue;
      var n = notes[id];
      html += '<span class="mm-dot c-' + n.color + '" style="left:' +
        Math.round(n.x * sx) + 'px;top:' + Math.round(n.y * sy) + 'px"></span>';
    }

    for (var i = 0; i < peers.length; i++) {
      var p = peers[i];
      if (!p.vw || !p.vh) continue;
      html += '<span class="mm-view' + (p.idle ? ' idle' : '') + '" style="left:' +
        Math.round(p.vx * sx) + 'px;top:' + Math.round(p.vy * sy) +
        'px;width:' + Math.max(6, Math.round(p.vw * sx)) +
        'px;height:' + Math.max(6, Math.round(p.vh * sy)) +
        'px;border-color:' + peerColor(p.color) + '">' +
        '<span class="mm-label" style="background:' + peerColor(p.color) + '">' +
        escapeHTML(p.name) + '</span></span>';
    }

    // Mine last, so it draws on top. Viewport converted to wall coordinates so
    // it stays comparable with peers at different zoom levels.
    html += '<span class="mm-view me" style="left:' + Math.round(scrollX() / zoom * sx) +
      'px;top:' + Math.round(scrollY() / zoom * sy) +
      'px;width:' + Math.max(6, Math.round(viewW() / zoom * sx)) +
      'px;height:' + Math.max(6, Math.round(viewH() / zoom * sy)) + 'px"></span>';

    lastMinimap = setHTML(mmInner, html, lastMinimap);
  }

  function peerColor(c) {
    return {
      yellow: '#c8a020', pink: '#c0607f', blue: '#3f7fbf',
      green: '#4a9a4a', orange: '#c07830', purple: '#7f5fbf'
    }[c] || '#888';
  }

  // Tap the minimap to jump to that part of the wall.
  minimap.onclick = function (e) {
    var r = minimap.getBoundingClientRect ? minimap.getBoundingClientRect() : null;
    if (!r) return;
    var fx = (e.clientX - r.left) / minimap.offsetWidth;
    var fy = (e.clientY - r.top) / minimap.offsetHeight;
    window.scrollTo(
      Math.max(0, fx * wallW * zoom - viewW() / 2),
      Math.max(0, fy * wallH * zoom - viewH() / 2)
    );
  };

  // ----------------------------------------------------------------- poll
  // One request per cycle carries both the state delta and our presence
  // heartbeat. On slow hardware every extra round trip is felt.

  function poll() {
    var url = '/api/state?since=' + seq +
      '&wall=' + encodeURIComponent(wallId) +
      '&id=' + encodeURIComponent(myId) +
      '&name=' + encodeURIComponent(myName) +
      // Presence travels in wall coordinates so peers at different zoom levels
      // still describe the same rectangle.
      '&vx=' + Math.round(scrollX() / zoom) +
      '&vy=' + Math.round(scrollY() / zoom) +
      '&vw=' + Math.round(viewW() / zoom) +
      '&vh=' + Math.round(viewH() / zoom) +
      '&_=' + new Date().getTime(); // cache buster for old IE

    xhr('GET', url, null, function (err, data) {
      if (err || !data) {
        failures++;
        statusEl.className = 'err';
        lastStatus = setHTML(statusEl, 'offline (retrying)', lastStatus);
      } else {
        failures = 0;
        statusEl.className = '';
        lastStatus = setHTML(statusEl, data.peers.length
          ? data.peers.length + ' other' + (data.peers.length > 1 ? 's' : '') + ' here'
          : 'synced', lastStatus);

        if (data.wall && (data.wall.w !== wallW || data.wall.h !== wallH)) {
          wallW = data.wall.w;
          wallH = data.wall.h;
          wall.style.width = wallW + 'px';
          wall.style.height = wallH + 'px';
          applyZoom();
        }
        if (data.colors && data.colors.length !== colors.length) {
          colors = data.colors;
          myColor = store('attic.color') || colors[0];
          buildSwatches();
        }

        for (var i = 0; i < data.notes.length; i++) {
          var n = data.notes[i];
          // Never clobber the note currently open in the editor: local intent
          // beats a stale server echo.
          if (n.id === editingId) continue;
          renderNote(n);
        }
        seq = data.seq;
        drawMinimap(data.peers);
      }

      // Back off when the server is unreachable so a sleeping tablet does not
      // hammer the network on wake.
      var base = einkOn ? POLL_MS_EINK : POLL_MS;
      var delay = failures > 3 ? Math.min(30000, base * failures) : base;
      window.setTimeout(poll, delay);
    });
  }

  // ----------------------------------------------------------------- boot

  wall.style.width = wallW + 'px';
  wall.style.height = wallH + 'px';
  applyZoom();
  buildSwatches();
  refreshEmptyState();
  loadTemplates();

  if (/[?&]eink=1/.test(window.location.search) || store('attic.eink')) setEink(true);
  if (/[?&]kiosk=1/.test(window.location.search) || store('attic.kiosk')) setKiosk(true);

  poll();
})();
