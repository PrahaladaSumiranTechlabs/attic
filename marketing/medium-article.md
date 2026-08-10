# Medium article

Longer and more technical than the LinkedIn piece — Medium readers will follow
the engineering. Paste the body below into the Medium editor.

**Suggested title:** I built a whiteboard that runs on a 2012 iPad, because
every other one needs a GPU

**Subtitle:** What happens when you treat "must run on old hardware" as the
requirement instead of the compromise

**Tags:** JavaScript, Web Development, Self Hosted, E Waste, Side Projects

**Cover image:** a photo of the wall running on your actual old tablet. Not a
screenshot — the point is the hardware.

---

There is an iPad in a drawer in my house. The screen works. The battery works.
It stopped getting software updates years ago, and there is nothing wrong with
it that a landfill would fix.

I wanted a shared sticky-note wall on it. The family kind: groceries,
half-formed ideas, who is collecting whom. So I went looking.

The market is well served. Miro, Excalidraw, tldraw, AFFiNE — all good tools,
several of them open source and self-hostable. Not one of them will run on that
tablet.

That is not laziness on their part, and this is the part I found genuinely
interesting. Every one of those products renders to a GPU-backed canvas. That
decision is load-bearing: it is what makes an infinite, smooth, zoomable board
possible in a browser at all. You cannot bolt compatibility onto it afterwards.
You would have to rewrite the renderer, and then you would have a different,
worse product for everyone currently paying you.

So there is a whole category of hardware that modern collaboration software has
quietly, structurally abandoned. Not because the hardware broke. Because the
software moved and the hardware could not follow.

I decided to build the other way round: treat the old device as the target
rather than the compromise tier, and find out what that costs.

## What you have to give up

The constraint immediately deletes most of the obvious architecture.

**No canvas, no WebGL.** Notes are absolutely positioned `<div>` elements. Zoom
is a single CSS transform on their container. You get the infinite-canvas *feel*
— pan, zoom, fit-to-content — without ever asking the GPU for anything.

**No WebSocket.** Sync is ordinary HTTP polling, roughly once a second. This
sounds like the biggest compromise and turned out to be the smallest. Polling
survives flaky wifi, sleeping tablets and hotel captive portals far better than
a socket does; there is no reconnect logic, no heartbeat, no backoff state
machine, because a request either works or you try again in a second. And it
works in browsers older than WebSocket itself.

**No dependencies.** The server is Node's built-in `http` and `sqlite`. No build
step, no bundler, no transpiler. The client is hand-written ES5 — not ES6
compiled down to ES5, actually written that way, because then there is no build
configuration to get subtly wrong two years from now.

**No accounts.** The security boundary is your network. That is a real trade,
and I will come back to it.

What you get in return is a wall that opens on essentially anything, and a
server you can read end to end in an afternoon.

## The bit I did not expect to enjoy

Partway through it became obvious that e-readers are the same problem wearing a
different hat. A Kindle or a Boox is a perfectly good screen attached to a
browser from another era.

Building an e-ink mode taught me that most "e-ink CSS" advice online is written
for *LCDs imitating e-ink* to cut blue light — sepia filters, reduced
saturation, softened contrast. On actual e-paper that is backwards. The panel is
reflective; there is no backlight to soften. You want maximum contrast, pure
black on pure white.

More usefully:

- **Borders instead of fills.** Grey fills ghost badly across partial refreshes.
- **Colour re-encoded as texture.** The panel is greyscale, so the six sticky
  colours become six border styles: solid, dashed, dotted, double, thick.
- **Stop repainting things that did not change.** This was the real lesson. The
  app rewrote its status text and minimap on every poll. Invisible waste on an
  LCD. On e-paper, a visible flash every 1.5 seconds. Every live-updating region
  now compares before it writes.

I also set the e-ink poll interval to 8 seconds, reasoning that fewer requests
meant fewer refreshes. That was wrong, and it took a bug report to see why:
polling does not repaint anything — only a *change* does, and changes were
already guarded. All 8 seconds bought was a wall that looked broken, because a
note added elsewhere took most of ten seconds to appear. It is 3 seconds now.

## Four bugs worth admitting to

The features were mostly straightforward. The failures taught me more.

**A QR encoder that produced beautiful, unscannable codes.** The app puts your
machine's address on screen as a QR so a tablet can scan it instead of you
typing an IP with a thumb. Writing the encoder from scratch, my first version
had the two format-information copies transposed, overwrote two timing-pattern
modules, and erased the always-dark module. Every code it produced looked
*exactly* like a working QR. There is no way to eyeball this. The only honest
check was to compare, module for module, against a reference implementation —
which is now a test, and which caught all three.

**A desktop app that shipped with no server.** The Electron wrapper forks the
server as a child process. `fork()` runs it on *Electron's* bundled Node, not
the system one — and Electron 33 bundles Node 20, which has no `node:sqlite`.
The server died instantly at `require()`. Every CI check stayed green, because
CI ran the server on system Node. The app opened onto a window with nothing
behind it.

**A guard that could not fail.** I wrote a build step to catch links that would
404 on the static site, checking "are any absolute paths left?" It could never
fire: the rewrite strips every leading slash *first*, so an unhandled `/whatever`
becomes a relative `whatever` and the check reports success while shipping a
404. It passed a deliberately broken link. It now verifies every reference
against the files actually shipped — and I proved it by feeding it a dead link
and watching it exit non-zero.

**One tap froze the entire wall.** A note's `mousedown` calls `preventDefault()`
to own the drag. `preventDefault()` also cancels the browser's focus change. So
the inline text box never blurred, the "currently editing" flag stayed set, and
every subsequent drag bailed out early. Tap one note and nothing was draggable
again until reload.

That last one is my favourite, because the fix is one line and the diagnosis is
the whole job. It also only reproduces if you drive the real event sequence —
mousedown, blur, mouseup, click. My tests had been calling handlers directly,
which passed cheerfully while the app was unusable.

## The limits I decided to publish

There is a table on the site listing which devices work. The last row says
**no**.

A pre-2008 machine cannot negotiate modern TLS and has no current certificate
authorities in its trust store. It can never reach an HTTPS site. That is not a
missing feature or a roadmap item — it is a cryptographic wall. On your own
network over plain HTTP it works fine, and I would rather say that plainly than
let someone discover it after an hour of trying.

Authentication is the same kind of honesty. There isn't any. The security
boundary is your network, not a login screen, and that trade buys the property
the whole thing exists for: a wall-mounted tablet comes up *showing the wall*,
with no session expiring overnight and no password to type on a 2012 on-screen
keyboard. Keep it on your LAN or behind a VPN. Do not port-forward it.

The one place that stance was genuinely dangerous was deletion. With no accounts
and no audit trail, one mistaken tap could destroy a whole room from a single
confirm dialog. So deleted notes are tombstones with an Undo button, and
deleting a room writes the entire room to a JSON file next to the database
before touching it — readable, restorable, and obvious enough that somebody
could rescue it without this app's help.

## Was it worth it

Around 60 million tablets are sold each year, and the ones they replace mostly
do not die. They stop being supported. That is a software decision presented as
a hardware outcome.

I am not claiming a sticky-note app fixes e-waste. But it was worth finding out
how much perfectly good hardware gets excluded by defaults nobody revisits, and
the answer is: about a decade's worth, usually one architectural choice deep.

The thing that surprised me most is how little the constraint actually cost.
No canvas, no sockets, no dependencies, no build step — and the result still
pans, zooms, syncs in about a second, does real kanban columns, links notes
together, and shares read-only links. The restraint was not a sacrifice. It was
mostly just a different set of defaults.

Attic is free, open source (AGPL-3.0) and self-hosted. Your notes never leave
your network.

**github.com/PrahaladaSumiranTechlabs/attic**

If you have an old tablet in a drawer, I would genuinely like to know whether it
works — and especially if it doesn't. That is the more useful bug report.
