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

## Walls

The URL is the wall.

- `/` — the default wall. What a home server wants.
- `/w/<slug>` — a named wall, created by being visited. Like codeshare: open the
  link and it exists. **new wall** mints a slug like `dusty-lantern-402` —
  three words, because a wall name gets read aloud across a room at least as
  often as it gets copied.

Walls are fully isolated: notes and presence never cross between them.

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
| `POST` | `/api/wall/new` | mints an unused slug |
| `GET` | `/api/walls` | walls with note counts |
| `GET` | `/api/templates` | available templates |
| `POST` | `/api/template` | `{name, wall, author}` — seeds notes |
| `GET` | `/api/health` | liveness |

## Development

```bash
node scripts/smoke-test.js
```

Boots the real server on a scratch database and exercises the API — delta sync,
wall isolation, tombstones, presence leakage, templates, and that `/legacy`
still contains no `<script>` tag.

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

## Licence

AGPL-3.0-or-later. If you run a modified copy as a network service, the licence
requires you to publish your changes.
