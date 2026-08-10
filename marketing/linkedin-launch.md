# LinkedIn article — launch

Paste the body below into LinkedIn's article editor. Suggested cover image: a
screenshot of the wall on an actual old tablet, propped somewhere domestic. A
real photo of real hardware will outperform any render here — the whole claim is
that it runs on a real device, so show the device.

---

## Every whiteboard tool needs a GPU. So I built one that doesn't.

There is an iPad in a drawer in my house. The screen works. The battery works.
It has not received a software update since roughly the year Ed Sheeran released
*Divide*, and there is nothing wrong with it that a landfill would fix.

I wanted to put a shared sticky-note wall on it — the family kind. Groceries,
half-formed ideas, who is picking up whom. So I went looking, and found the
market is well served: Miro, Excalidraw, tldraw, AFFiNE. All good tools.

Not one of them will run on that tablet.

That is not laziness on their part. Every one of those products renders to a GPU
canvas, and that decision is load-bearing — it is what makes an infinite,
buttery, zoomable board possible in a browser. You do not bolt compatibility
onto that afterwards. You would have to rewrite the renderer.

Which means there is a category of hardware that modern collaboration software
has quietly, structurally abandoned. Not because the hardware is broken. Because
the software moved.

So I built the other way round.

### The constraint is the product

**Attic** is a sticky-note wall that syncs across devices. The interesting part
is what is missing from it:

- **No canvas, no WebGL.** Notes are absolutely positioned `<div>` elements.
  Zoom is a CSS transform. You get the infinite-canvas *feel* without the
  hardware bill.
- **No WebSocket.** Sync is ordinary HTTP polling, about once a second. This
  sounds like a downgrade and mostly is not: it survives flaky wifi, sleeping
  tablets and hotel captive portals far better than a socket does, and it works
  in browsers older than WebSocket itself.
- **No dependencies.** The server is Node's built-in `http` and `sqlite`. No
  build step. `node server.js` and it is running.
- **No accounts.** More on that below, because it is a real trade and not a
  shortcut.

The client is hand-written ES5. No transpiler — because then there is no build
configuration to get subtly wrong two years from now.

### The bit I did not expect to enjoy: e-paper

Somewhere in the middle of this, it became obvious that e-readers are the same
problem wearing a different hat. A Kindle or a Boox is a perfectly good screen
attached to a browser from another era.

So there is an e-ink mode. Building it taught me that most "e-ink CSS" advice
online is written for LCDs *imitating* e-ink to cut blue light — sepia filters,
softened contrast. On actual e-paper that is backwards. The panel is reflective;
there is no backlight to soften. You want maximum contrast, borders instead of
fills (grey fills ghost on partial refresh), and colour re-encoded as border
*texture*, because the panel is greyscale.

The subtler fix: I had to stop the app repainting the status text every poll.
Invisible waste on an LCD. On e-paper, a visible flash every 1.5 seconds.

### Three bugs worth admitting to

Building this, three failures taught me more than the features did.

**The QR encoder.** I wrote one from scratch to avoid a dependency — it puts
your machine's address on screen so a tablet can scan it instead of you typing
an IP with a thumb. My first version produced codes that were *beautiful* and
completely unscannable. Format bits transposed, timing modules overwritten, the
always-dark module erased. Every one of them looked exactly like a working QR.
The only way to know was to compare, module for module, against a reference
implementation. That comparison is now a test.

**The desktop app shipped broken.** Electron 33 bundles Node 20, which has no
`node:sqlite`. The forked server died instantly at `require()` — and every CI
check stayed green, because CI ran the server on *system* Node. The app opened
onto a window with nothing behind it.

**Tapping one note froze the whole wall.** A note's `mousedown` calls
`preventDefault()` to own the drag. `preventDefault()` also cancels the browser's
focus change. So the text box never blurred, the "currently editing" flag stayed
set, and every subsequent drag bailed out early. One tap and nothing was
draggable again.

Each of those is now a test that exists because something broke, which is the
only good reason for a test to exist.

### The honest limits

I have a table on the site listing which devices work. The last row says **no**.

A pre-2008 machine cannot negotiate modern TLS and has no current certificate
authorities in its trust store. It can never reach an HTTPS site. Not a missing
feature — a cryptographic wall. On your own network over plain HTTP it works
fine, and I would rather say that up front than let someone find out.

Same with authentication: there isn't any. The security boundary is your
network, not a login screen. That is a deliberate trade, and it buys the thing
the product exists for — a wall-mounted tablet comes up *showing the wall*, with
no session expiring overnight and no password to type on a 2012 on-screen
keyboard. Keep it on your LAN or behind a VPN. Do not port-forward it.

### Why this matters beyond one drawer

Roughly 60 million tablets are sold every year, and the ones they replace mostly
do not die — they stop being supported. That is a software decision presented as
a hardware outcome.

I am not claiming a sticky-note app fixes e-waste. But it was worth finding out
how much perfectly good hardware is excluded by defaults nobody revisits. The
answer, it turns out, is: a decade's worth, and the exclusion is usually one
architectural choice deep.

Attic is free, open source (AGPL), and self-hosted. Your notes never leave your
network.

**Source and downloads:** github.com/PrahaladaSumiranTechlabs/attic

If you have an old tablet in a drawer, I would genuinely like to know whether it
works — especially if it doesn't. That is the more useful bug report.

---

## Shorter version — for a LinkedIn post rather than an article

> There's an iPad in my drawer. The screen works. The battery works. It just
> stopped getting updates.
>
> I wanted a shared sticky-note wall on it. Miro, Excalidraw, tldraw — all good
> tools, none of them will run on it. Not laziness: they all render to a GPU
> canvas, and that's load-bearing. You can't bolt compatibility on afterwards.
>
> So I built one the other way round. No canvas — notes are just divs. No
> WebSocket — polling survives sleeping tablets better anyway. No dependencies.
> No build step.
>
> Along the way I wrote a QR encoder that produced perfect-looking, completely
> unscannable codes, and shipped a desktop app whose server died at `require()`
> while every CI check stayed green.
>
> It also runs on e-readers, which turn out to be the same problem in a
> different hat.
>
> Free, open source, self-hosted: github.com/PrahaladaSumiranTechlabs/attic
>
> If you've got an old tablet in a drawer, I'd like to know if it works — and
> especially if it doesn't.
