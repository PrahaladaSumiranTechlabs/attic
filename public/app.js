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
  var inlineTA = null;
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

  // Room configuration: display name, layout, and columns when it is a board.
  var meta = { wall: 'main', title: '', layout: 'free', columns: [] };
  var lastMetaJSON = '';
  var laneEls = [];
  var boardContentH = 320;

  // Kanban geometry, in wall coordinates.
  var COL_W = 300;
  var COL_GAP = 22;
  var BOARD_PAD = 40;
  var LANE_HEAD = 54;
  var CARD_GAP = 12;
  var CARD_INSET = 12;

  // The URL is the wall. /w/<slug> names one; bare / is the default wall, which
  // is what a self-hosted box on a home network actually wants.
  // Both /<room> and the longer /w/<room> alias resolve to the same wall.
  // /v/<token> is a read-only share link: the viewer is never told which room
  // it is looking at, so the link cannot be turned back into an editing one.
  var wallId = 'main';
  var viewOnly = false;
  var viewToken = '';

  var path = window.location.pathname;
  var vm = path.match(/^\/v\/([a-z0-9]{6,32})\/?$/);
  var vw = path.match(/^\/(?:([a-z0-9][a-z0-9-]{0,47})\/)?view\/?$/);

  if (vm) {
    // Token form: we are not told which room this is, and do not need to be.
    viewOnly = true;
    viewToken = vm[1];
  } else if (vw) {
    // Simple form: /kitchen/view, or bare /view for the default room.
    viewOnly = true;
    wallId = vw[1] || 'main';
  } else {
    var m = path.match(/^\/(?:w\/)?([a-z0-9][a-z0-9-]{0,47})\/?$/);
    if (m) wallId = m[1];
  }

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
  function toWallX(clientX) { return (clientX + scrollX() - offX) / zoom; }
  function toWallY(clientY) { return (clientY + scrollY() - offY) / zoom; }

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

  // offX/offY shift the wall inside the viewport. Scrolling alone cannot centre
  // content that is smaller than the screen — scroll position clamps at zero —
  // so "fit" translates the wall instead of trying to scroll to a negative
  // offset. Manual zoom clears it and returns to the ordinary scrollable wall.
  var offX = 0;
  var offY = 0;

  function applyZoom(canvasW, canvasH) {
    var t = '';
    if (offX || offY) t += 'translate(' + Math.round(offX) + 'px,' + Math.round(offY) + 'px) ';
    if (zoom !== 1) t += 'scale(' + zoom + ')';
    setTransform(wall, t);
    canvas.style.width = Math.round(canvasW === undefined ? wallW * zoom : canvasW) + 'px';
    canvas.style.height = Math.round(canvasH === undefined ? wallH * zoom : canvasH) + 'px';
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
    // Any manual zoom drops the fitted framing and goes back to the plain
    // scrollable wall, so the two never fight over where the origin is.
    offX = 0;
    offY = 0;
    removeClass(body, 'fitted');
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

  // Fit to what is actually on the wall, not to the wall. Fitting 4000x3000 of
  // mostly empty grid put the content in a corner and made it unreadable.
  function contentBounds() {
    var minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity, any = false;

    for (var id in notes) {
      if (!notes.hasOwnProperty(id)) continue;
      var el = els[id];
      if (!el) continue;
      var x = parseInt(el.style.left, 10) || 0;
      var y = parseInt(el.style.top, 10) || 0;
      var w = el.offsetWidth || notes[id].w;
      var h = el.offsetHeight || notes[id].h;
      any = true;
      if (x < minX) minX = x;
      if (y < minY) minY = y;
      if (x + w > maxX) maxX = x + w;
      if (y + h > maxY) maxY = y + h;
    }

    // Columns count as content even when empty, or an empty board would have
    // nothing to fit to.
    if (isKanban()) {
      var names = columnNames();
      any = true;
      minX = Math.min(minX, BOARD_PAD);
      minY = Math.min(minY, 0);
      maxX = Math.max(maxX, columnX(names.length - 1) + COL_W);
      maxY = Math.max(maxY, boardContentH);
    }

    if (!any) return null;

    // Deliberately not clamped to zero. Clamping truncates the padding on the
    // left and top only, which shifts the box off the content it describes and
    // makes "centred" come out visibly lopsided. Negative origins are fine —
    // the wall is translated into place, not scrolled.
    var pad = 60;
    var x0 = minX - pad;
    var y0 = minY - pad;
    return { x: x0, y: y0, w: (maxX + pad) - x0, h: (maxY + pad) - y0 };
  }

  function fitToContent() {
    var b = contentBounds();
    if (!b) { setZoom(1); return; }

    var top = (kioskOn || viewOnly) ? 0 : 48;
    // The viewer's control bar sits at the bottom; leave it room so the lowest
    // note is not tucked underneath it.
    var bottom = viewOnly ? 58 : 0;
    var availW = viewW();
    var availH = viewH() - top - bottom;

    var z = Math.min(availW / b.w, availH / b.h);
    // A shared view is usually a whole screen given over to one wall, so it
    // scales up to fill it. An editing view stops at 100%, where zooming past
    // life size would just make the note you are about to type into wobble.
    var maxZoom = viewOnly ? 3 : 1;
    z = Math.max(0.1, Math.min(maxZoom, z));

    zoom = z;
    fitted = true;

    var scaledW = b.w * z;
    var scaledH = b.h * z;

    // Pull the content's own top-left to the origin, then centre whatever slack
    // is left. When the content is larger than the screen the slack is zero and
    // this degrades to "start at the content, not at the empty grid".
    offX = -b.x * z + Math.max(0, (availW - scaledW) / 2);
    offY = -b.y * z + Math.max(0, (availH - scaledH) / 2) + top;

    addClass(body, 'fitted');
    window.scrollTo(0, 0);
    applyZoom(Math.max(availW, scaledW), Math.max(availH, scaledH) + top);
  }

  overviewBtn.onclick = function () {
    if (fitted) { setZoom(1); return; }
    fitToContent();
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

  // ----------------------------------------------------------------- links
  // Connections between two notes, drawn as SVG lines behind them. A link has
  // no direction — A-B and B-A are the same connection — and it belongs to
  // neither note, which is why it lives in its own table rather than as a field.

  var links = {};
  var svg = null;
  var linking = false;
  var linkFrom = null;

  function ensureSVG() {
    if (svg) return svg;
    svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('id', 'links');
    // Behind every note, so lines never sit on top of text.
    wall.insertBefore(svg, wall.firstChild);
    return svg;
  }

  function centreOf(id) {
    var el = els[id];
    if (!el) return null;
    return {
      x: (parseInt(el.style.left, 10) || 0) + el.offsetWidth / 2,
      y: (parseInt(el.style.top, 10) || 0) + el.offsetHeight / 2,
    };
  }

  function drawLinks() {
    var count = 0;
    for (var k in links) if (links.hasOwnProperty(k)) count++;
    if (!count) {
      if (svg) svg.innerHTML = '';
      return;
    }

    var s = ensureSVG();
    s.setAttribute('width', wallW);
    s.setAttribute('height', wallH);
    s.setAttribute('viewBox', '0 0 ' + wallW + ' ' + wallH);

    var parts = '';
    for (var id in links) {
      if (!links.hasOwnProperty(id)) continue;
      var l = links[id];
      var a = centreOf(l.a);
      var b = centreOf(l.b);
      if (!a || !b) continue; // an end is missing on this wall; skip quietly
      parts += '<line x1="' + a.x + '" y1="' + a.y + '" x2="' + b.x + '" y2="' + b.y +
        '" class="link" data-id="' + id + '"></line>';
      // A fat transparent line on top, so the thin visible one is still easy
      // to hit with a finger.
      parts += '<line x1="' + a.x + '" y1="' + a.y + '" x2="' + b.x + '" y2="' + b.y +
        '" class="link-hit" data-id="' + id + '"></line>';
    }
    s.innerHTML = parts;
  }

  function startLink() {
    if (!editingId) return;
    linkFrom = editingId;
    commitEdit();
    linking = true;
    addClass(body, 'linking');
    toast('Tap another note to connect it. Esc to stop.', 8000);
  }

  function stopLink() {
    linking = false;
    linkFrom = null;
    removeClass(body, 'linking');
  }

  function finishLink(toId) {
    var from = linkFrom;
    stopLink();
    if (!from || !toId || from === toId) return;

    var tempId = 'tmp' + Date.now();
    links[tempId] = { id: tempId, a: from, b: toId };
    drawLinks();

    xhr('POST', '/api/link', { wall: wallId, a: from, b: toId }, function (err, data) {
      delete links[tempId];
      if (!err && data && data.id) links[data.id] = { id: data.id, a: from, b: toId };
      drawLinks();
      if (!err) toast('Linked');
    });
  }

  function deleteLink(id) {
    delete links[id];
    drawLinks();
    xhr('POST', '/api/link/delete', { wall: wallId, id: id }, function () {});
  }

  // Clicking a connection offers to remove it; there is nothing else you can
  // do to a line.
  wall.addEventListener('click', function (e) {
    var t = e.target;
    if (!t || !t.getAttribute) return;
    var id = t.getAttribute('data-id');
    if (!id || !links[id] || viewOnly) return;
    if (window.confirm('Remove this connection?')) deleteLink(id);
  }, false);

  // ---------------------------------------------------------------- kanban
  // A real board, not notes arranged to look like one: a card belongs to a
  // column, the column decides where it sits, and dropping it somewhere else
  // changes which column owns it. Still absolutely positioned divs — no canvas,
  // no drag-and-drop API, nothing an old tablet cannot do.

  function isKanban() { return meta.layout === 'kanban'; }

  function columnNames() {
    return (meta.columns && meta.columns.length) ? meta.columns : ['To do', 'Doing', 'Done'];
  }

  function columnX(i) { return BOARD_PAD + i * (COL_W + COL_GAP); }

  function buildLanes(names) {
    // Rebuild only when the column set actually changed; otherwise every poll
    // would throw away and recreate the lane elements.
    var signature = JSON.stringify(names);
    if (wall.getAttribute('data-lanes') === signature) return;
    wall.setAttribute('data-lanes', signature);

    for (var i = 0; i < laneEls.length; i++) {
      if (laneEls[i].parentNode) laneEls[i].parentNode.removeChild(laneEls[i]);
    }
    laneEls = [];

    for (var j = 0; j < names.length; j++) {
      var lane = document.createElement('div');
      lane.className = 'lane';
      lane.style.left = columnX(j) + 'px';
      lane.style.width = COL_W + 'px';
      var head = document.createElement('div');
      head.className = 'lane-head';
      head.innerHTML = escapeHTML(names[j]) + '<span class="lane-count"></span>';
      lane.appendChild(head);
      // Behind the cards, which are appended to #wall directly.
      wall.insertBefore(lane, wall.firstChild);
      laneEls.push(lane);
    }
  }

  function groupByColumn(names) {
    var groups = {};
    var i;
    for (i = 0; i < names.length; i++) groups[names[i]] = [];

    for (var id in notes) {
      if (!notes.hasOwnProperty(id)) continue;
      var n = notes[id];
      // A card whose column was renamed or removed is shown in the first
      // column rather than vanishing. It is not rewritten on the server until
      // somebody actually moves it.
      if (groups[n.col]) groups[n.col].push(n);
      else groups[names[0]].push(n);
    }

    for (i = 0; i < names.length; i++) {
      groups[names[i]].sort(function (a, b) {
        return (a.ord - b.ord) || (a.seq - b.seq);
      });
    }
    return groups;
  }

  function layoutKanban() {
    var names = columnNames();
    buildLanes(names);
    var groups = groupByColumn(names);
    var tallest = 0;

    for (var i = 0; i < names.length; i++) {
      var list = groups[names[i]];
      var x = columnX(i) + CARD_INSET;
      var y = LANE_HEAD + CARD_GAP;

      for (var j = 0; j < list.length; j++) {
        var el = els[list[j].id];
        if (!el) continue;
        el.style.left = x + 'px';
        el.style.width = (COL_W - CARD_INSET * 2) + 'px';
        // Height comes from the content: a one-line card should not be as tall
        // as a paragraph. Measured after the width is applied.
        el.style.height = 'auto';
        el.style.top = y + 'px';
        y += el.offsetHeight + CARD_GAP;
      }

      if (laneEls[i]) {
        var count = laneEls[i].firstChild.lastChild;
        if (count) count.innerHTML = list.length ? String(list.length) : '';
      }
      if (y > tallest) tallest = y;
    }

    // Lane height follows the cards, not the viewport. Stretching lanes to fill
    // the screen made the board taller than the screen, so "fit" could never
    // show the bottom of it.
    boardContentH = Math.max(tallest + 40, 320);
    for (var k = 0; k < laneEls.length; k++) laneEls[k].style.height = boardContentH + 'px';

    wallW = Math.max(BOARD_PAD * 2 + names.length * (COL_W + COL_GAP), viewW());
    wallH = Math.max(boardContentH + BOARD_PAD * 2, viewH());
    wall.style.width = wallW + 'px';
    wall.style.height = wallH + 'px';
    applyZoom();
    drawLinks();
  }

  // Where would a card dropped at this point land?
  function dropTarget(clientX, clientY, movingId) {
    var names = columnNames();
    var wx = toWallX(clientX);
    var wy = toWallY(clientY);

    var best = 0;
    for (var i = 0; i < names.length; i++) {
      if (wx >= columnX(i) - COL_GAP / 2) best = i;
    }

    var list = groupByColumn(names)[names[best]].filter(function (n) {
      return n.id !== movingId;
    });

    // Index is decided by how many cards start above the drop point.
    var index = 0;
    var y = LANE_HEAD + CARD_GAP;
    for (var j = 0; j < list.length; j++) {
      var el = els[list[j].id];
      var h = el ? el.offsetHeight : 120;
      if (wy > y + h / 2) index = j + 1;
      y += h + CARD_GAP;
    }
    return { column: names[best], index: index, siblings: list };
  }

  function moveCard(id, clientX, clientY) {
    var t = dropTarget(clientX, clientY, id);
    var moving = notes[id];
    t.siblings.splice(t.index, 0, moving);

    // Renumber the destination column so ordering survives a reload. Only the
    // cards whose position actually changed get written back.
    for (var i = 0; i < t.siblings.length; i++) {
      var n = t.siblings[i];
      if (n.col === t.column && n.ord === i) continue;
      n.col = t.column;
      n.ord = i;
      saveNote(n, null, true);
    }
    layoutKanban();
  }

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
    // In kanban the column owns the geometry, so only the freeform wall reads
    // x/y/w/h off the note itself.
    if (!isKanban()) {
      el.style.left = n.x + 'px';
      el.style.top = n.y + 'px';
      el.style.width = n.w + 'px';
      el.style.height = n.h + 'px';
    }
    el.firstChild.innerHTML = escapeHTML(n.text) +
      (n.author ? '<span class="author">' + escapeHTML(n.author) + '</span>' : '');
    refreshEmptyState();
  }

  function saveNote(n, cb, skipLayout) {
    if (viewOnly) return;
    notes[n.id] = n;
    renderNote(n);
    n.wall = wallId;
    if (isKanban() && !skipLayout) layoutKanban();
    xhr('POST', '/api/note', n, function (err, data) {
      if (!err && data && data.seq) seq = Math.max(seq, data.seq);
      if (cb) cb(err);
    });
  }

  function deleteNote(id) {
    if (viewOnly) return;
    var el = els[id];
    if (el && el.parentNode) el.parentNode.removeChild(el);
    delete els[id];
    delete notes[id];
    refreshEmptyState();
    // Drop this note's connections locally too; the server does the same.
    for (var lid in links) {
      if (!links.hasOwnProperty(lid)) continue;
      if (links[lid].a === id || links[lid].b === id) delete links[lid];
    }
    drawLinks();
    xhr('POST', '/api/note/delete', { id: id, wall: wallId }, function () {});
  }

  // ------------------------------------------------------------- dragging
  // Manual hit-testing on touch + mouse. HTML5 drag-and-drop does not exist on
  // old mobile Safari, and pointer events are far too new to rely on.

  function attachDrag(el, id) {
    var startX, startY, origX, origY, moved, downAt, lastX, lastY;

    function down(e) {
      if (viewOnly || editingId || kioskOn) return;
      var t = e.touches ? e.touches[0] : e;
      startX = lastX = t.clientX;
      startY = lastY = t.clientY;
      // In kanban the card's current pixel position is the drag origin, since
      // its x/y fields describe where it sat on the freeform wall instead.
      origX = isKanban() ? parseInt(el.style.left, 10) || 0 : notes[id].x;
      origY = isKanban() ? parseInt(el.style.top, 10) || 0 : notes[id].y;
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
      lastX = t.clientX;
      lastY = t.clientY;
      // Screen movement divided by zoom: at 50% the pointer travels twice as
      // far as the note should.
      var dx = (t.clientX - startX) / zoom;
      var dy = (t.clientY - startY) / zoom;
      if (Math.abs(dx) > 4 / zoom || Math.abs(dy) > 4 / zoom) moved = true;

      if (isKanban()) {
        // Cards follow the finger freely while dragging and snap into a column
        // on release. Live reordering mid-drag is a lot of layout work for
        // hardware that cannot spare it.
        el.style.left = (origX + dx) + 'px';
        el.style.top = (origY + dy) + 'px';
      } else {
        var nx = Math.max(0, Math.min(wallW - notes[id].w, origX + dx));
        var ny = Math.max(0, Math.min(wallH - notes[id].h, origY + dy));
        notes[id].x = nx;
        notes[id].y = ny;
        el.style.left = nx + 'px';
        el.style.top = ny + 'px';
      }
      drawLinks();
      if (e.preventDefault) e.preventDefault();
    }

    function up() {
      document.removeEventListener('touchmove', move, false);
      document.removeEventListener('touchend', up, false);
      document.removeEventListener('mousemove', move, false);
      document.removeEventListener('mouseup', up, false);
      removeClass(el, 'dragging');

      if (moved) {
        if (isKanban()) moveCard(id, lastX, lastY);
        else saveNote(notes[id]);
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
      if (viewOnly || editingId || kioskOn) return;
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
  // You type in the note, not in a dialog about the note. The old modal made
  // "+ note" save an empty note and then rely on the right button to clean it
  // up — dismiss it any other way and a blank ghost note stayed on the wall.

  var actions = document.getElementById('noteactions');

  function positionActions(id) {
    var el = els[id];
    if (!el) return;
    var r = el.getBoundingClientRect();
    // Kept on screen even when the note is at the edge of the viewport.
    var left = Math.min(Math.max(8, r.left), viewW() - actions.offsetWidth - 8);
    var top = r.bottom + 8;
    if (top > viewH() - 46) top = Math.max(56, r.top - 46);
    actions.style.left = Math.round(left) + 'px';
    actions.style.top = Math.round(top) + 'px';
  }

  function openEditor(id) {
    if (viewOnly) return;
    if (linking) { finishLink(id); return; }
    if (editingId && editingId !== id) commitEdit();

    editingId = id;
    var el = els[id];
    if (!el) return;

    if (!inlineTA) {
      inlineTA = document.createElement('textarea');
      inlineTA.className = 'note-edit';
      // Commit on blur: clicking anywhere else is how you finish a note, the
      // same way it works on a paper one.
      inlineTA.onblur = function () { if (editingId) commitEdit(); };
      inlineTA.onkeydown = function (e) {
        var code = e.keyCode || e.which;
        if (code === 27) { cancelEdit(); return false; }
        // Ctrl/Cmd+Enter finishes, plain Enter is a new line.
        if (code === 13 && (e.ctrlKey || e.metaKey)) { commitEdit(); return false; }
        if (e.stopPropagation) e.stopPropagation();
        return true;
      };
      wall.appendChild(inlineTA);
    }

    addClass(el, 'editing');
    inlineTA.value = notes[id].text;
    inlineTA.style.left = el.style.left;
    inlineTA.style.top = el.style.top;
    inlineTA.style.width = el.offsetWidth + 'px';
    inlineTA.style.height = el.offsetHeight + 'px';
    inlineTA.className = 'note-edit open c-' + notes[id].color;

    actions.className = 'open';
    positionActions(id);

    // Old iOS will not focus a textarea outside a user gesture; this sits
    // inside the touchend handler chain, so it works.
    try {
      inlineTA.focus();
      var len = inlineTA.value.length;
      if (inlineTA.setSelectionRange) inlineTA.setSelectionRange(len, len);
    } catch (e) {}
  }

  function hideEditor() {
    if (editingId && els[editingId]) removeClass(els[editingId], 'editing');
    editingId = null;
    if (inlineTA) inlineTA.className = 'note-edit';
    actions.className = '';
  }

  function commitEdit() {
    if (!editingId) return;
    var id = editingId;
    var n = notes[id];
    var text = inlineTA ? inlineTA.value : '';
    hideEditor();
    if (!n) return;

    // A note with nothing in it is not a note. This is what stops "+ note"
    // from littering the wall every time somebody changes their mind.
    if (!text.replace(/^\s+|\s+$/g, '')) { deleteNote(id); return; }
    if (text === n.text) return;

    n.text = text;
    n.author = myName;
    saveNote(n);
  }

  function cancelEdit() {
    if (!editingId) return;
    var id = editingId;
    var n = notes[id];
    hideEditor();
    // Escape on a note that was never given any text removes it, rather than
    // leaving the blank note the old modal used to leave behind.
    if (n && !n.text.replace(/^\s+|\s+$/g, '')) deleteNote(id);
  }

  document.getElementById('act-done').onclick = function () { commitEdit(); };
  document.getElementById('act-link').onclick = function () { startLink(); };

  // Finish the open note as soon as a press lands anywhere else.
  //
  // This cannot be left to the textarea's blur event. A note's mousedown calls
  // preventDefault to own the drag, and preventDefault also cancels the focus
  // change — so the textarea never blurred, editingId stayed set, and every
  // later drag returned early. Tapping one note froze the entire wall.
  //
  // Capture phase, so it runs before the note's own handler and the drag it
  // starts sees editingId already cleared.
  function commitOnOutsidePress(e) {
    if (!editingId) return;
    var t = e.target;
    if (t === inlineTA) return;
    // Let the action bar's own buttons act on the note first.
    var node = t;
    while (node) {
      if (node === actions) return;
      node = node.parentNode;
    }
    commitEdit();
  }

  document.addEventListener('mousedown', commitOnOutsidePress, true);
  document.addEventListener('touchstart', commitOnOutsidePress, true);

  document.getElementById('act-del').onclick = function () {
    if (!editingId) return;
    var id = editingId;
    hideEditor();
    deleteNote(id);
  };

  document.getElementById('act-color').onclick = function () {
    if (!editingId) return;
    var n = notes[editingId];
    var i = colors.indexOf(n.color);
    n.color = colors[(i + 1) % colors.length];
    if (inlineTA) inlineTA.className = 'note-edit open c-' + n.color;
    saveNote(n);
    // saveNote re-rendered the element, so the editing marker has to go back on.
    if (els[editingId]) addClass(els[editingId], 'editing');
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

  // The chip shows the room's given name when it has one, and falls back to the
  // slug in the URL. The slug is what you type; the title is what you call it.
  function applyLayout() {
    wallNameEl.innerHTML = escapeHTML(meta.title || wallId);
    wallNameEl.title = meta.title
      ? meta.title + ' (' + wallId + ') — tap to manage rooms'
      : 'this room — tap to see and switch rooms';

    if (isKanban()) {
      addClass(body, 'board');
      layoutKanban();
    } else {
      removeClass(body, 'board');
      wall.removeAttribute('data-lanes');
      for (var i = 0; i < laneEls.length; i++) {
        if (laneEls[i].parentNode) laneEls[i].parentNode.removeChild(laneEls[i]);
      }
      laneEls = [];
      wallW = 4000;
      wallH = 3000;
      wall.style.width = wallW + 'px';
      wall.style.height = wallH + 'px';
      // Freeform positions were never applied while the board owned geometry.
      for (var id in notes) if (notes.hasOwnProperty(id)) renderNote(notes[id]);
      applyZoom();
    }
  }

  function saveMeta(patch, cb) {
    var payload = { wall: wallId };
    if (patch.title !== undefined) payload.title = patch.title;
    if (patch.layout !== undefined) payload.layout = patch.layout;
    if (patch.columns !== undefined) payload.columns = patch.columns;
    xhr('POST', '/api/wall', payload, function (err, data) {
      if (!err && data && data.meta) {
        meta = data.meta;
        lastMetaJSON = JSON.stringify(meta);
        applyLayout();
      }
      if (cb) cb(err);
    });
  }

  // Tapping the room chip answers "what rooms are there?", which is otherwise
  // unanswerable: rooms exist by being visited, so nothing lists them until
  // something asks the server.
  var roombox = document.getElementById('roombox');

  function refreshRoomList() {
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

          var label = w.title ? escapeHTML(w.title) +
            ' <span class="slug">/' + escapeHTML(w.wall) + '</span>' : escapeHTML(w.wall);

          row.innerHTML =
            '<button class="room-del" type="button" title="delete this room">&times;</button>' +
            '<span class="count">' + w.notes + (w.notes === 1 ? ' note' : ' notes') +
            (w.layout === 'kanban' ? ' · columns' : '') + '</span>' +
            label + (here ? '<span class="tag">you are here</span>' : '');

          var go = row.querySelector ? row.querySelector('.room-del') : null;
          if (go) {
            go.onclick = function (e) {
              if (e.stopPropagation) e.stopPropagation();
              deleteRoom(w);
            };
          }

          row.onclick = function () {
            if (here) return;
            window.location.href = w.wall === 'main' ? '/' : '/' + w.wall;
          };
          list.appendChild(row);
        })(walls[j]);
      }
    });
  }

  // Deleting a room throws its notes away for everyone, so the confirmation
  // names the room and says how much is in it rather than asking "are you sure".
  function deleteRoom(w) {
    var what = (w.title ? w.title + ' (/' + w.wall + ')' : '/' + w.wall);
    var msg = 'Delete ' + what + ' and its ' + w.notes +
      (w.notes === 1 ? ' note' : ' notes') + '?\n\nThis cannot be undone.';
    if (!window.confirm(msg)) return;

    xhr('POST', '/api/wall/delete', { wall: w.wall }, function (err) {
      if (err) { toast('Could not delete that room'); return; }
      if (w.wall === wallId) {
        // You just deleted the room you are standing in.
        window.location.href = '/';
        return;
      }
      refreshRoomList();
      toast('Deleted ' + what);
    });
  }

  function openRooms() {
    roombox.className = 'open';
    document.getElementById('room-title').value = meta.title || '';
    markLayoutButtons();
    refreshRoomList();
  }

  function markLayoutButtons() {
    var free = document.getElementById('layout-free');
    var kan = document.getElementById('layout-kanban');
    if (isKanban()) { addClass(kan, 'on'); removeClass(free, 'on'); }
    else { addClass(free, 'on'); removeClass(kan, 'on'); }
  }

  // Renaming moves the room's address too. A display name that leaves the URL
  // at /main is a name only half applied — "Kitchen Ideas" should live at
  // /kitchen-ideas, and the old address forwards so tablets keep working.
  document.getElementById('room-rename').onclick = function () {
    var title = document.getElementById('room-title').value;
    xhr('POST', '/api/wall/rename', { wall: wallId, title: title }, function (err, data) {
      if (err || !data || !data.ok) { toast('Could not rename that room'); return; }
      if (data.moved && data.url) {
        window.location.href = data.url;
        return;
      }
      meta = data.meta;
      lastMetaJSON = JSON.stringify(meta);
      applyLayout();
      refreshRoomList();
      toast(data.note ? 'Renamed — ' + data.note : 'Renamed');
    });
  };

  document.getElementById('layout-free').onclick = function () {
    saveMeta({ layout: 'free' }, markLayoutButtons);
  };

  document.getElementById('layout-kanban').onclick = function () {
    var cols = (meta.columns && meta.columns.length) ? meta.columns : ['To do', 'Doing', 'Done'];
    saveMeta({ layout: 'kanban', columns: cols }, markLayoutButtons);
  };

  document.getElementById('edit-columns').onclick = function () {
    var current = columnNames().join(', ');
    var next = window.prompt('Columns, separated by commas:', current);
    if (next === null) return;
    var list = [];
    var parts = next.split(',');
    for (var i = 0; i < parts.length; i++) {
      var name = parts[i].replace(/^\s+|\s+$/g, '');
      if (name) list.push(name);
    }
    if (!list.length) { toast('A board needs at least one column'); return; }
    saveMeta({ layout: 'kanban', columns: list }, markLayoutButtons);
  };

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

  function showShare(path, hint) {
    var qrBox = document.getElementById('share-qr');
    var urlBox = document.getElementById('share-url');
    urlBox.innerHTML = 'finding this machine&rsquo;s address&hellip;';
    qrBox.innerHTML = '';
    document.getElementById('share-hint').innerHTML = hint;

    xhr('GET', '/api/addresses', null, function (err, data) {
      var host = window.location.host;
      if (!err && data && data.addresses && data.addresses.length) {
        host = data.addresses[0].address + ':' + data.port;
      }
      var url = 'http://' + host + path;
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
  }

  function shareEditable() {
    addClass(document.getElementById('share-edit'), 'on');
    removeClass(document.getElementById('share-view'), 'on');
    removeClass(document.getElementById('share-alt'), 'shown');
    showShare(wallPath(),
      'Anyone who opens this can add and change notes.');
  }

  // The short form by default, because a link you can say across a room beats
  // a link you have to copy. The trade is that stripping "/view" off it gets
  // you the editable room — hence the private option below it.
  function shareReadOnly() {
    removeClass(document.getElementById('share-edit'), 'on');
    addClass(document.getElementById('share-view'), 'on');
    addClass(document.getElementById('share-alt'), 'shown');
    document.getElementById('share-alt').innerHTML = 'or a link that hides the room name';
    showShare(wallPath() === '/' ? '/view' : wallPath() + '/view',
      'Opens read-only. Nothing can be changed from this link.');
  }

  function sharePrivateView() {
    document.getElementById('share-url').innerHTML = 'making a private link&hellip;';
    document.getElementById('share-qr').innerHTML = '';
    xhr('POST', '/api/wall/share', { wall: wallId }, function (err, data) {
      if (err || !data || !data.url) {
        document.getElementById('share-url').innerHTML = 'could not create a view link';
        return;
      }
      document.getElementById('share-alt').innerHTML = 'or the short link';
      showShare(data.url,
        'Read-only, and the room name is not in the link.');
    });
  }

  document.getElementById('share-alt').onclick = function () {
    if (/hides the room/.test(this.innerHTML)) sharePrivateView();
    else shareReadOnly();
  };

  document.getElementById('share').onclick = function () {
    sharebox.className = 'open';
    shareEditable();
  };

  document.getElementById('share-edit').onclick = shareEditable;
  document.getElementById('share-view').onclick = shareReadOnly;

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
    if (linking) { stopLink(); toast('Linking cancelled'); return; }
    if (editingId) { cancelEdit(); return; }
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
    // The viewer has its own button for this; keep both in step from one place,
    // since boot restores the stored preference after the viewer is wired up.
    var vb = document.getElementById('view-eink');
    if (vb) { if (on) addClass(vb, 'on'); else removeClass(vb, 'on'); }
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
    var url = viewOnly
      ? '/api/view?since=' + seq +
        (viewToken ? '&token=' + encodeURIComponent(viewToken)
                   : '&wall=' + encodeURIComponent(wallId)) +
        '&_=' + new Date().getTime()
      : '/api/state?since=' + seq +
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

        if (data.meta) {
          var mj = JSON.stringify(data.meta);
          if (mj !== lastMetaJSON) {
            lastMetaJSON = mj;
            meta = data.meta;
            applyLayout();
          }
        }

        if (!isKanban() && data.wall && (data.wall.w !== wallW || data.wall.h !== wallH)) {
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

        if (data.links) {
          for (var li = 0; li < data.links.length; li++) {
            var lk = data.links[li];
            if (lk.deleted) delete links[lk.id];
            else links[lk.id] = lk;
          }
        }

        for (var i = 0; i < data.notes.length; i++) {
          var n = data.notes[i];
          // Never clobber the note currently open in the editor: local intent
          // beats a stale server echo.
          if (n.id === editingId) continue;
          renderNote(n);
        }
        seq = data.seq;
        if (isKanban() && data.notes.length) layoutKanban();
        drawLinks();
        drawMinimap(data.peers);

        // A share link should open already framed, not scrolled to a corner of
        // an empty grid. Once, after the first payload has been laid out.
        if (viewOnly && countNotes()) {
          if (!didFirstFit) {
            didFirstFit = true;
            setHTML(document.getElementById('view-title'),
                    escapeHTML(meta.title || 'Shared wall'), null);
            window.setTimeout(fitToContent, 60);
          } else if (fitted && data.notes.length) {
            // Notes moved or arrived. A shared screen nobody is driving should
            // re-frame itself rather than let new notes fall off the edge.
            window.setTimeout(fitToContent, 60);
          }
        }
      }

      // Back off when the server is unreachable so a sleeping tablet does not
      // hammer the network on wake.
      var base = einkOn ? POLL_MS_EINK : POLL_MS;
      var delay = failures > 3 ? Math.min(30000, base * failures) : base;
      window.setTimeout(poll, delay);
    });
  }

  // ------------------------------------------------------------ view mode
  // What a share link opens: the wall, fitted, and nothing to press by
  // accident. Greyscale is here because a wall shared onto someone else's
  // screen — or a projector, or a monochrome panel — reads better without six
  // sticky-note colours competing.

  var didFirstFit = false;

  function setMono(on) {
    if (on) addClass(body, 'mono'); else removeClass(body, 'mono');
    var b = document.getElementById('view-mono');
    if (on) addClass(b, 'on'); else removeClass(b, 'on');
    store('attic.mono', on ? '1' : '');
  }

  if (viewOnly) {
    addClass(body, 'viewonly');
    document.getElementById('view-fit').onclick = function () { fitToContent(); };
    document.getElementById('view-mono').onclick = function () {
      setMono(!hasClass(body, 'mono'));
    };

    // Greyscale and e-ink are different things: greyscale is a filter over a
    // normal screen, e-ink is a different visual system for e-paper hardware.
    // A shared wall is exactly what you would leave on an e-paper panel, so
    // the viewer gets its own switch rather than borrowing the toolbar's.
    document.getElementById('view-eink').onclick = function () {
      setEink(!einkOn);
      // Borders replace fills, so the content box changes size; re-frame for it.
      if (fitted) window.setTimeout(fitToContent, 60);
    };

    if (store('attic.mono')) setMono(true);

    // Re-fit on rotation or resize: a shared wall is usually left open on a
    // screen nobody is driving, and it should still frame itself.
    window.onresize = function () { if (fitted) fitToContent(); };
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
