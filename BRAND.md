# Attic — brand

**Attic. Everything you forgot you had.**

A shared idea wall that runs on the tablet in your drawer.

## The idea in one line

Attic is the opposite of a boardroom tool. Miro sells collaboration by the seat;
Attic puts a wall in a kitchen, running on hardware that was otherwise landfill.
Everything below should feel domestic and slightly worn-in, never corporate.

**Voice:** plain, warm, specific. Say what a thing does and what it costs you.
Never "seamless", "empower", "revolutionise". If a limit exists, name it — the
README says out loud that a pre-2008 machine can never reach an HTTPS site, and
that is the register.

## The mark

A sticky note with a pitched roofline cut into its top edge. It reads as a note
and as a house at 16px, which is the whole positioning in one shape.

- **Never** redraw it with a chimney, a door, or a window. It is a note first.
- Keep the two rule lines. They are what stop it becoming a generic house icon.
- Minimum size 16px. Below that, drop the rule lines rather than let them mush.
- It sits **left of the wordmark**, never above it, never inside a container.

Source of truth: `public/favicon.svg`. The app toolbar inlines the same geometry
(`#mark` in `index.html`), and `scripts/make-icon.js` rasterises it to
`public/icon.png` for the desktop app — run `npm run icon` after any change so
all three stay identical.

## Wordmark

"Attic", weight 700, letter-spacing `0.055em`, in gold `#8a6d1f`. The spacing is
deliberate: tight enough to read as a word, open enough not to look like a
system label. Never all-caps, never italic.

## Colour

No CSS custom properties anywhere. They do not exist on the browsers this
product exists to support, so the values below are written literally in
`style.css`. **This file is the register; the stylesheet is the copy.** Change
both together.

### Surface

| Token | Hex | Use |
| --- | --- | --- |
| Paper | `#f4f1ea` | The wall itself. The default ground everywhere. |
| Card | `#fffdf8` | Panels, buttons, anything sitting on the paper. |
| Line | `#e2ddd0` | Every border and rule. |
| Ink | `#23211c` | Body text. Never pure black on paper. |
| Muted | `#6f6a5e` | Secondary text. |
| Faint | `#9a9384` | Status, counts, captions. |

### Brand

| Token | Hex | Use |
| --- | --- | --- |
| Gold | `#8a6d1f` | Wordmark, primary buttons, room names. |
| Gold deep | `#7a5f16` | Primary button border and pressed state. |
| Gold bright | `#c8a020` | Mark outline, active toggle borders. |
| Gold pale | `#ffe89a` | Active toggle fill. Also the yellow note. |
| Alert | `#b03030` | Destructive actions only. Never decorative. |

### Notes

Six, and six only. They are the product's only saturated colour, so nothing else
competes with them.

| | Hex |
| --- | --- |
| Yellow | `#ffe89a` |
| Pink | `#ffc2d1` |
| Blue | `#bfe0ff` |
| Green | `#c6ecc6` |
| Orange | `#ffd4a8` |
| Purple | `#dcc9f5` |

All six carry `#2b2b2b` text at comfortable contrast. If you add a seventh,
check it against that ink first — a note nobody can read is not a colour option.

### Greyscale and e-ink

Two different things, and they are not interchangeable:

- **Greyscale** (`body.mono`) is a CSS filter over the wall, for a shared view on
  a projector or someone else's screen. Colour is removed, layout untouched.
- **E-ink** (`body.eink`) is a different visual system for e-paper hardware:
  pure black on pure white, borders instead of fills, colour re-encoded as border
  *texture*, animation gone, polling slowed. See the README.

## Typography

System stack only — `"Helvetica Neue", Helvetica, Arial, sans-serif`. A webfont
would mean a network request and a full-page repaint on a device that can afford
neither, and it would break the no-dependency rule.

| Role | Size | Weight |
| --- | --- | --- |
| Wordmark | 15.5px | 700 |
| Note body | 16px | 400 |
| Buttons | 14px | 400 / 600 when primary |
| Section labels | 13px, uppercase, `0.08em` | 400 |
| Status and captions | 12px | 400 |

Never below 16px for anything typed into — iOS zooms the page when a smaller
input takes focus.

## Buttons

Three weights, and the distinction is the point. Eight identical grey buttons
told you nothing about which one you came to press.

- **Primary** — gold fill, light text. *One* per surface. In the toolbar that is
  `+ note`, because adding a note is the only reason the wall exists.
- **Default** — card fill, line border. Occasional actions: new wall, share.
- **Icon / toggle** — quietest until active, then gold-pale fill. Zoom steppers,
  fit, display, e-ink.

Group them with `.bar-sep` rules into clusters — identity, creating, sharing,
viewing, modes — so the row can be scanned instead of read.

## Layout habits

- Touch targets **44px minimum**. The target device has a low-DPI screen and an
  imprecise finger.
- Shadows are soft and warm, never grey-blue: `rgba(0,0,0,.16)` at most.
- Radius 5–6px on chrome, 2px on notes. A sticky note has square corners.
- Nothing animates. It cannot on the target hardware, and it would be the first
  thing to break on e-paper.

## Applying it

The system lives in three files, and they must agree:

| File | Holds |
| --- | --- |
| `public/style.css` | Every literal value above |
| `public/favicon.svg` | The mark |
| `public/landing.html` | Its own copy, since it may assume a modern browser |

The landing page is the one place allowed to use CSS custom properties and
`prefers-color-scheme` — nobody evaluates a product on a 2011 tablet, so it can
be modern. The app itself may not.
