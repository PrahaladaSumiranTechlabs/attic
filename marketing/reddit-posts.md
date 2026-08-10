# Reddit posts

Reddit punishes marketing and rewards specifics. Each version below is written
for one subreddit's actual culture — do not cross-post the same text, and read
each sub's self-promotion rules first. Several require a minimum account age or
limit self-promo to a fraction of your comments.

**Before posting anywhere:** publish a release so the download link works, and
be ready to answer comments for the first two hours. A post with no author
replies dies regardless of quality.

**The honest framing that works on Reddit:** lead with the constraint and the
bugs, not the product. People upvote an interesting problem and get suspicious
of an interesting product.

---

## r/selfhosted

*Their rule of thumb: show what it does, say what it costs, no hype.*

**Title:** Attic — a sticky-note wall that runs on tablets too old for Miro or
Excalidraw. No deps, no build step, ~1s sync.

**Body:**

I had an old iPad in a drawer with a working screen and a working battery that
nothing would run on anymore, so I wrote a shared sticky-note wall that targets
it deliberately.

The short version of why nothing else works: Miro, Excalidraw, tldraw and AFFiNE
all render to a GPU canvas. That is load-bearing architecture, not an oversight,
so none of them will ever run on a 2012 tablet.

**What it is**
- Sticky notes on a wall you can pan and zoom, syncing across devices in about a second
- Rooms at their own URL (`/kitchen`), created by being opened
- Free-form walls or real kanban columns — a card belongs to a column, and converting between layouts reads the arrangement you already made
- Read-only share links (`/kitchen/view`) with a greyscale switch for projectors
- Display mode for a wall-mounted tablet, e-ink mode for e-readers
- A no-JavaScript fallback that renders the whole wall server-side

**Running it**
- Desktop app for Windows/macOS/Linux — double-click, it serves your network and shows a QR for other devices
- Or `node server.js` on a Pi. Zero npm dependencies, no build step. Node's built-in `http` + `sqlite`. State is one SQLite file you can copy.

**What it deliberately does not do**
- **No authentication.** The security boundary is your network, not a login screen — that is what lets a wall-mounted tablet come up showing the wall instead of a sign-in form. Fine on a LAN or behind Tailscale; do not port-forward it.
- **No WebSocket.** Polling survives sleeping tablets and captive portals better, and works in browsers older than WebSocket.
- **No canvas.** Notes are positioned divs; zoom is a CSS transform.

Deleting is the one thing that could destroy work with no accounts and no audit
trail, so deleted notes are tombstones with an Undo, and deleting a room writes
the whole room to JSON next to the database first.

AGPL-3.0, self-hosted, free: github.com/PrahaladaSumiranTechlabs/attic

Happy to answer anything about the architecture. If you have genuinely old
hardware I would love to know whether it works on it — especially if it doesn't.

---

## r/javascript

*Wants the engineering, not the product. Lead with the constraint.*

**Title:** I wrote a collaborative whiteboard with no canvas, no WebSocket and
no dependencies, because it had to run on a 2012 tablet

**Body:**

Every collaborative whiteboard renders to a GPU canvas, which is exactly what an
old tablet cannot do. I wanted one that ran on the iPad in my drawer, so I took
the constraint seriously and treated the old device as the target rather than the
compromise tier.

What that deleted from the architecture:

- **Canvas → positioned divs.** Zoom is one CSS transform on the container. Pan, zoom and fit-to-content all work; nothing touches the GPU.
- **WebSocket → HTTP polling** at ~1s. Smaller than expected a loss: no reconnect logic, no heartbeat, no backoff state machine, and it survives sleeping tablets and captive portals better. Also works in browsers older than WebSocket.
- **Dependencies → none.** Node's built-in `http` and `sqlite`. The client is hand-written ES5 rather than ES6 compiled to ES5, so there is no build config to get wrong later.

Four bugs that were more instructive than the features:

1. **A QR encoder that produced perfect-looking, completely unscannable codes.** Format bits transposed, timing modules overwritten, dark module erased. You cannot eyeball this — the only real check was comparing module-for-module against a reference implementation, which is now a test.
2. **`preventDefault()` on `mousedown` froze the whole wall.** It also cancels the focus change, so the inline textarea never blurred, the "editing" flag stayed set, and every later drag bailed early. Tap one note, nothing draggable again.
3. **A packaged Electron app whose server died at `require()`.** `fork()` runs the child on Electron's bundled Node — v33 ships Node 20, which has no `node:sqlite`. CI stayed green because CI used system Node.
4. **A build guard that could not fail.** It asked "any absolute paths left?" after a rewrite that strips leading slashes. It passed a deliberately broken link.

The last two only show up if you test the real thing in the real shape — driving
actual event sequences, and checking the packaged artifact rather than the source.

Source (AGPL): github.com/PrahaladaSumiranTechlabs/attic

---

## r/ereader or r/eink

*Small, knowledgeable, allergic to anything that has not actually been run on
e-paper. **Only post here once you have run it on a real device** and can say so.*

**Title:** Made a shared sticky-note wall with a proper e-ink mode — max
contrast, borders instead of fills, no animation

**Body:**

I built a self-hosted sticky-note wall and gave it a real e-ink mode, because
e-readers are perfectly good screens attached to browsers everything else has
abandoned.

Building it, I noticed most "e-ink CSS" advice online is actually written for
*LCDs imitating e-ink* to reduce blue light — sepia filters, reduced saturation,
softened contrast. On actual e-paper that is backwards: the panel is reflective,
there is no backlight to soften, and you want maximum contrast.

What the mode actually does:
- Pure black on pure white, no grey fills — grey ghosts across partial refreshes
- **Borders instead of fills**, and the six note colours re-encoded as border *styles* (solid, dashed, dotted, double) since the panel is greyscale
- No animation anywhere
- Every live-updating region compares before it writes, so nothing repaints unless it changed. I had been rewriting the status text on every poll — invisible on an LCD, a visible flash every 1.5s on e-paper.
- Slower polling, but not silly-slow: I had it at 8s, which only made the wall look broken, since polling repaints nothing on its own. It is 3s now.

It also has a read-only view mode with an e-ink switch, so a device can sit on a
shelf showing a wall someone else is editing.

Free, open source, self-hosted: github.com/PrahaladaSumiranTechlabs/attic

I would really like to know how it behaves on hardware I do not own — refresh
artefacts, ghosting, anything the mode gets wrong.

---

## Notes on timing and expectations

- Post to **one** subreddit at a time, a few days apart. Simultaneous posting reads as a campaign and gets removed.
- Best days are Tue–Thu mornings US time for r/selfhosted and r/javascript.
- Expect the top comment to be "why not just use Excalidraw / Trello / a whiteboard". Have the one-line answer ready: *those need a GPU canvas; this is for the tablet that cannot run them.*
- Expect someone to point out the lack of auth. Do not get defensive — it is a documented trade, and saying so plainly is what earns trust in these subs.
- If a post does badly, it is usually the title. The body is rarely the problem.
