'use strict';

// Generates public/icon.png from the same geometry as favicon.svg.
//
// Written by hand rather than pulled from a library because the whole project
// has no dependencies, and an icon generator is not the place to break that.
// Run it when the mark changes: node scripts/make-icon.js

const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');

// 1024, not 256. Windows accepts a 256px icon; macOS and Linux both require at
// least 512, and electron-builder fails the whole build rather than scaling one
// up — which is why Windows releases succeeded while mac and linux did not.
const S = 1024;                      // output is square
const OUT = path.join(__dirname, '..', 'public', 'icon.png');

const CREAM = [244, 241, 234, 255];
const NOTE = [255, 232, 154, 255];
const EDGE = [200, 160, 32, 255];
const LINE = [184, 144, 26, 255];
const CLEAR = [0, 0, 0, 0];

// House geometry, scaled from the 64-unit favicon grid.
const k = S / 64;
const APEX = [32 * k, 12 * k];
const LEFT = [12 * k, 27 * k];
const RIGHT = [52 * k, 27 * k];
const BODY_TOP = 27 * k;
const BODY_BOT = 51 * k;

function inTriangle(px, py, a, b, c) {
  const d = (b[1] - c[1]) * (a[0] - c[0]) + (c[0] - b[0]) * (a[1] - c[1]);
  if (d === 0) return false;
  const w1 = ((b[1] - c[1]) * (px - c[0]) + (c[0] - b[0]) * (py - c[1])) / d;
  const w2 = ((c[1] - a[1]) * (px - c[0]) + (a[0] - c[0]) * (py - c[1])) / d;
  return w1 >= 0 && w2 >= 0 && w1 + w2 <= 1;
}

function inHouse(x, y) {
  if (inTriangle(x, y, APEX, LEFT, RIGHT)) return true;
  return x >= LEFT[0] && x <= RIGHT[0] && y >= BODY_TOP && y <= BODY_BOT;
}

// Border = inside the shape but close enough to the outside to count as edge.
function onEdge(x, y, d) {
  if (!inHouse(x, y)) return false;
  return !inHouse(x - d, y) || !inHouse(x + d, y) ||
         !inHouse(x, y - d) || !inHouse(x, y + d) ||
         !inHouse(x - d, y - d) || !inHouse(x + d, y - d);
}

function inRoundedSquare(x, y, r) {
  const nx = Math.min(Math.max(x, r), S - r);
  const ny = Math.min(Math.max(y, r), S - r);
  const dx = x - nx;
  const dy = y - ny;
  return dx * dx + dy * dy <= r * r;
}

function inRule(x, y, rx, ry, rw, rh) {
  return x >= rx && x <= rx + rw && y >= ry && y <= ry + rh;
}

const raw = Buffer.alloc(S * (S * 4 + 1)); // one filter byte per scanline
let o = 0;

for (let y = 0; y < S; y++) {
  raw[o++] = 0; // filter: none
  for (let x = 0; x < S; x++) {
    // Sample at pixel centre, un-rotated. The SVG tilts the note a few degrees;
    // at icon sizes that tilt reads as blur, so the raster version sits square.
    const px = x + 0.5;
    const py = y + 0.5;

    let c = CLEAR;
    if (inRoundedSquare(px, py, S * 0.172)) c = CREAM;

    if (inHouse(px, py)) {
      c = NOTE;
      if (inRule(px, py, 20 * k, 33 * k, 24 * k, 3.5 * k)) c = LINE;
      else if (inRule(px, py, 20 * k, 41 * k, 16 * k, 3.5 * k)) c = LINE;
      if (onEdge(px, py, S / 51)) c = EDGE;
    }

    raw[o++] = c[0]; raw[o++] = c[1]; raw[o++] = c[2]; raw[o++] = c[3];
  }
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body) >>> 0);
  return Buffer.concat([len, body, crc]);
}

let CRC_TABLE = null;
function crc32(buf) {
  if (!CRC_TABLE) {
    CRC_TABLE = new Int32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let j = 0; j < 8; j++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      CRC_TABLE[n] = c;
    }
  }
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return c ^ -1;
}

const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(S, 0);
ihdr.writeUInt32BE(S, 4);
ihdr[8] = 8;  // bit depth
ihdr[9] = 6;  // colour type: RGBA
ihdr[10] = 0; // deflate
ihdr[11] = 0; // adaptive filtering
ihdr[12] = 0; // no interlace

const png = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  chunk('IHDR', ihdr),
  chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
  chunk('IEND', Buffer.alloc(0)),
]);

fs.writeFileSync(OUT, png);
console.log('wrote ' + OUT + ' (' + S + 'x' + S + ', ' + png.length + ' bytes)');
