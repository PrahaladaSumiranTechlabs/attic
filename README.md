# Attic

**Everything you forgot you had.**

A shared idea wall that syncs across your devices — including the ones nobody
else supports anymore.

## Why it exists

Every collaborative whiteboard (Miro, tldraw, Excalidraw, AFFiNE) renders to a
GPU canvas. That is load-bearing architecture, not an oversight, so none of them
will ever run on the tablet in your drawer. Attic is built the other way round:
**the server may be as modern as it likes, but the client is held to what a 2011
tablet can execute.** The old device is the target, not the compromise tier.

## Running it

**Desktop app** — download from [Releases](https://github.com/PrahaladaSumiranTechlabs/attic/releases).
Double-click it; it serves your whole network and shows the address other
devices should open. Closing the window leaves it running in the tray, because
the other devices are still using it.

**Server** — for a Pi, a NAS, or a VPS:

```bash
node server.js
```

No dependencies, no build step, no install. Node 22.5+ (uses the built-in
`node:sqlite`). State is a single SQLite file — back it up by copying it.

| Env var | Default | Purpose |
| --- | --- | --- |
| `PORT` | `8080` | listen port |
| `HOST` | `0.0.0.0` | bind address (`0.0.0.0` = reachable on the LAN) |
| `NOTER_DB` | `./noter.db` | database path |
| `ATTIC_LANDING` | unset | `1` serves the landing page at `/` and the wall at `/wall` |

## Rooms

The URL is the room.

- `/` — the default wall. What a home server wants.
- `/<room>` — e.g. `http://192.168.0.189:8080/kitchen`, created by being
  visited. Like codeshare: open the link and it exists. `/w/<room>` is a longer
  alias for the same thing.
- **new wall** mints a slug like `dusty-lantern-402` — three words, because a
  room name gets read aloud across a room at least as often as it gets copied.

Rooms are fully isolated: notes and presence never cross between them. A room
name may not contain a dot, which is what stops one shadowing a static file —
every asset has an extension, no room does. A handful of names (`api`, `legacy`,
`connect`, …) are reserved.

Tap the room chip in the toolbar to open the room panel. From there you can:

- **Give the room a name.** The address stays a slug (`/sprint`); the name can
  be anything (`Sprint 14 Board`) and is what the chip and the room list show.
- **Switch layout** between a free wall and columns, and edit the column names.
- **See every room** on the server with its note count, and switch between them.
- **Delete a room.** This is a hard delete of its notes and its configuration,
  confirmed by name and note count rather than a bare "are you sure".

## Free wall or columns

A room is one of two things, and can be switched at any time without losing
anything:

**Free wall** — notes go anywhere, they keep `x`/`y`, you pan and zoom around.

**Columns** — a real board, not notes arranged to look like one. A card *belongs
to* a column and carries `col`/`ord` instead of coordinates; the column decides
where it sits; dropping a card elsewhere changes which column owns it and
renumbers the destination. Cards are sized by their content, and the manual
resize grip is hidden because the column owns the geometry.

Both layouts share one `notes` table. Freeform notes leave `col`/`ord` alone and
cards leave `x`/`y` alone, so switching a room back and forth loses nothing. A
card whose column was renamed or removed shows up in the first column rather
than vanishing, and is only rewritten when somebody actually moves it.

The **Kanban**, **Retro** and **Week** templates all set the layout and the
columns — a template that only *looked* like a kanban was the thing worth
fixing.

## Fit

**fit** frames what is actually on the wall, not the wall. Two things this has
to get right, both of which were wrong first:

- It **centres** the content. Scroll position clamps at zero, so content smaller
  than the viewport can never be centred by scrolling — the wall is translated
  instead.
- It **clips** while fitted. The wall is a 4000px-wide absolutely positioned
  element; without clipping, the page scrolls sideways into empty space.

## Connecting a device

Typing an IP address into an old tablet is the worst part of self-hosting, so
there are three ways around it:

- **share** in the toolbar shows a QR for the current room, pointed at this
  machine's LAN address — not at whatever hostname your browser is using, since
  `localhost` is no use to the tablet you are setting up.
- **`/connect`** is a page listing every network address this machine has, each
  with its own QR. Leave it open while you set tablets up.
- The desktop app's tray menu has **Connect a device (QR)** and **Copy address**.

The QR encoder is ours (`lib/qr.js`) — byte mode, error correction level M,
versions 1–10, no dependencies. It is verified module-for-module against the
Python `qrcode` reference by `scripts/check-qr.js`, because a QR that is subtly
wrong looks exactly like a QR that works.

## Settings

The server takes environment variables. The desktop app has no command line to
put them on, so it reads `settings.json` from its user-data folder — reachable
from the tray under **Settings (port, host)**:

```json
{ "port": 8080, "host": "0.0.0.0", "openWindowOnStart": true }
```

If the port is already in use the app walks forward to the next free one and
logs where it landed, rather than failing to start. `ATTIC_PORT` overrides the
file, for scripts and CI.

## The three tiers

| Tier | Device | Route | How it works |
| --- | --- | --- | --- |
| A | Anything modern | `/` | Pan, zoom, drag, resize, live presence |
| B | 2010–2014 tablets | `/` | Same page: ES5, XHR polling, no WebSocket, no `<canvas>` |
| C | Genuinely ancient | `/legacy` | Server-rendered HTML + form + meta-refresh. Zero JS. |

Tier C exists for browsers that predate usable JavaScript. It works over plain
HTTP on the LAN only — a pre-2008 device cannot negotiate TLS 1.2 and has no
modern CA roots, so it can never reach an HTTPS deployment. That limit is
cryptographic, not something the app can route around.

## Using it

- **+ note** drops a note in the middle of your view and opens the editor.
- **Tap a note** to edit, **drag** to move, **corner grip** to resize.
- **Drag the empty board** to pan (mouse). On touch, ordinary scrolling does it.
- **− / +** zoom, anchored on the viewport centre. **Ctrl/Cmd + wheel** zooms too.
- **fit** zooms out to the whole wall and back.
- **display** is wall-mounted tablet mode: chrome hidden, dragging disabled so a
  passer-by cannot rearrange the board by brushing the screen. One floating
  **+** to add; the invisible top-left corner exits. Or start at `/?kiosk=1`.
- **e-ink** for e-paper hardware. See below. Or start at `/?eink=1`.
- **Minimap** shows every note as a dot and every other device as a labelled
  rectangle where they are parked. Tap to jump.
- **Templates** (idea wall, kanban, retro, week) seed an empty wall. A template
  is a seeding action, not a mode — nothing locks afterwards, so a kanban board
  can quietly become something else when the work changes shape.

## E-ink

Built for actual e-paper — Boox, Kindle, reMarkable, Kobo — not an LCD imitating
the look. That inverts the usual "e-ink CSS" advice you will find online, which
is about reducing blue light on backlit screens:

- **Maximum contrast, not softened.** The panel is reflective; there is no
  backlight to take the edge off.
- **Borders instead of fills.** Grey fills ghost across partial refreshes.
- **Colour becomes border texture** — solid, dashed, dotted, double — because
  the panel is greyscale.
- **Presence is hidden and polling slows to 8s.** A live-updating region on
  e-paper is a refresh loop you can watch.

## Design rules

These are the product. Breaking one costs you the old-device promise:

- **No dependencies in the server.** `node:http` + `node:sqlite`.
- **No WebSocket.** XHR polling works from IE6 to current Chrome. ~1.5s latency
  is imperceptible on a sticky wall, and it survives flaky wifi, sleeping
  tablets and captive portals far better than a socket does.
- **No `<canvas>`, no WebGL.** Notes are absolutely positioned `<div>`s; zoom is
  a CSS transform. The canvas *feel* without the canvas requirement.
- **ES5 client, hand-written.** No transpiler, because there is no build step to
  get wrong.
- **One request per poll cycle.** State delta and presence heartbeat ride
  together; on slow hardware every round trip is felt.
- **Never repaint what did not change.** Invisible waste on an LCD; a visible
  flash every cycle on e-paper.
- **Never block first paint.** A wall-mounted tablet comes up showing the wall.
  No login gate, no name prompt, no splash.

Electron is the one exception, and it is deliberately one-way: the desktop app
depends on the server, never the reverse. `node server.js` must keep working on
its own, because that is what anyone deploying to a Pi actually runs. CI checks
this on every build.

## How sync works

The server is authoritative. Every write bumps a global `seq`; clients poll
`GET /api/state?since=<seq>&wall=<slug>` and receive only what changed. Deletes
are tombstones (`deleted=1` with a fresh seq) so they propagate like any other
edit. Conflicts resolve last-write-wins per note — correct for an idea wall,
where two people editing the same note in the same instant is not a real
workflow.

`seq` is global rather than per-wall. Every write advances it, so a client
filtered to one wall still never misses an update, and there is one counter to
reason about.

Presence is in-memory and disposable: clients report their viewport rectangle
(in wall coordinates, so zoom levels stay comparable) on each poll, and peers
older than 12s are dropped. Restart the server and everyone re-announces within
a cycle. It shows *where someone is parked*, not a live cursor — cursor
streaming is exactly what old hardware cannot do.

## API

| Method | Path | Notes |
| --- | --- | --- |
| `GET` | `/api/state?since=&wall=&id=&name=&vx=&vy=&vw=&vh=` | delta + presence heartbeat. `since=-1` for a full snapshot |
| `POST` | `/api/note` | upsert. Accepts JSON or form-encoded |
| `POST` | `/api/note/delete` | `{id, wall}` |
| `POST` | `/api/wall` | `{wall, title?, layout?, columns?}` — rename, switch layout, set columns |
| `POST` | `/api/wall/delete` | `{wall}` — hard-deletes the room's notes and config |
| `POST` | `/api/wall/new` | mints an unused slug |
| `GET` | `/api/walls` | rooms with note counts, names and layouts |
| `GET` | `/api/templates` | available templates |
| `POST` | `/api/template` | `{name, wall, author}` — seeds notes |
| `GET` | `/api/health` | liveness |

## Development

```bash
node scripts/smoke-test.js       # API: delta sync, room isolation, tombstones,
                                 # presence leakage, templates, /legacy has no JS
node scripts/check-package.js    # everything server.js requires is in the build
node scripts/check-electron-node.js   # Electron's Node can run the server
node scripts/check-qr.js         # QR matches a reference implementation exactly
```

Each of those exists because something broke:

| Check | The failure it remembers |
| --- | --- |
| `check-package.js` | `lib/qr.js` shipped missing from the app; the window opened onto a server that had died at `require()` |
| `check-electron-node.js` | Electron 33 bundles Node 20, which has no `node:sqlite`, so the forked server exited instantly |
| `check-qr.js` | Format-info placement and timing-pattern overwrites produced QR codes that looked perfect and scanned as nothing |

```bash
npm install
npm run desktop
```

Runs the Electron shell against your working tree. `npm run icon` regenerates
`public/icon.png` from the same geometry as the favicon.

## Releases

Tag a version and CI builds installers for all three platforms into a draft
release:

```bash
git tag v0.1.0 && git push origin v0.1.0
```

Each OS builds its own artifacts, because electron-builder cannot produce a
signed macOS `.dmg` from Linux.

## Not built yet

- **Auth.** There is none. Anyone who can reach the server can edit any wall.
  Fine on a LAN or behind Tailscale; **not** fine on the public internet.
- **Accounts and private walls.** Needed before hosting this for other people.
- **Images and attachments.** Text notes only.
- **Undo.**

## Hosting and support

Attic is free and self-hosted, and there is nothing to upgrade to. If you want
it hosted for you — no machine to spare, a classroom, a lab — write to
**hello@pstechlabs.com** and we will sort something out.

If it saved you buying a tablet, [buy us a coffee](https://buymeacoffee.com/pstechlabs).
Entirely optional; it changes nothing about what you get.

## Licence

AGPL-3.0-or-later. If you run a modified copy as a network service, the licence
requires you to publish your changes.
