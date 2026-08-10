'use strict';

// A QR encoder, because the alternative was a dependency.
//
// Byte mode, error correction level M, versions 1-10 (up to 213 bytes) — far
// more than the "http://192.168.1.42:8080/kitchen" this exists to encode.
// Output is a boolean matrix; rendering is somebody else's problem.
//
// Verified against the Python `qrcode` reference implementation module-for-
// module across a range of inputs — see scripts/check-qr.js. Do not "tidy" the
// tables below without re-running it: a QR that is subtly wrong still looks
// exactly like a QR.

// ---------------------------------------------------------------- GF(256)
// Arithmetic for Reed-Solomon, over the QR polynomial x^8+x^4+x^3+x^2+1.

const EXP = new Uint8Array(512);
const LOG = new Uint8Array(256);
(function buildTables() {
  let x = 1;
  for (let i = 0; i < 255; i++) {
    EXP[i] = x;
    LOG[x] = i;
    x <<= 1;
    if (x & 0x100) x ^= 0x11d;
  }
  for (let i = 255; i < 512; i++) EXP[i] = EXP[i - 255];
})();

function gfMul(a, b) {
  if (a === 0 || b === 0) return 0;
  return EXP[LOG[a] + LOG[b]];
}

// Generator polynomial for `degree` error correction codewords.
function rsGenerator(degree) {
  let poly = [1];
  for (let d = 0; d < degree; d++) {
    const next = new Array(poly.length + 1).fill(0);
    for (let i = 0; i < poly.length; i++) {
      next[i] ^= poly[i];
      next[i + 1] ^= gfMul(poly[i], EXP[d]);
    }
    poly = next;
  }
  return poly;
}

function rsEncode(data, ecLen) {
  const gen = rsGenerator(ecLen);
  const rem = new Array(ecLen).fill(0);
  for (let i = 0; i < data.length; i++) {
    const factor = data[i] ^ rem[0];
    rem.shift();
    rem.push(0);
    if (factor !== 0) {
      for (let j = 0; j < ecLen; j++) rem[j] ^= gfMul(gen[j + 1], factor);
    }
  }
  return rem;
}

// ----------------------------------------------------------------- tables
// Level M only. [ecPerBlock, blocksG1, dataPerBlockG1, blocksG2, dataPerBlockG2]
// Sum of (blocks x (data + ec)) equals the version's total codeword count.

const ECC_M = {
  1:  [10, 1, 16, 0, 0],
  2:  [16, 1, 28, 0, 0],
  3:  [26, 1, 44, 0, 0],
  4:  [18, 2, 32, 0, 0],
  5:  [24, 2, 43, 0, 0],
  6:  [16, 4, 27, 0, 0],
  7:  [18, 4, 31, 0, 0],
  8:  [22, 2, 38, 2, 39],
  9:  [22, 3, 36, 2, 37],
  10: [26, 4, 43, 1, 44],
};

// Row/column centres of the alignment patterns, per version.
const ALIGN = {
  1: [], 2: [6, 18], 3: [6, 22], 4: [6, 26], 5: [6, 30],
  6: [6, 34], 7: [6, 22, 38], 8: [6, 24, 42], 9: [6, 26, 46], 10: [6, 28, 50],
};

function dataCapacity(version) {
  const [, b1, d1, b2, d2] = ECC_M[version];
  return b1 * d1 + b2 * d2;
}

// Byte-mode payload capacity: total data codewords, less the 4-bit mode
// indicator and the character count field (8 bits below version 10, 16 at 10).
function byteCapacity(version) {
  const countBits = version < 10 ? 8 : 16;
  return dataCapacity(version) - Math.ceil((4 + countBits) / 8);
}

function pickVersion(byteLen) {
  for (let v = 1; v <= 10; v++) if (byteLen <= byteCapacity(v)) return v;
  throw new Error('payload too long for this encoder (max ' + byteCapacity(10) + ' bytes)');
}

// ------------------------------------------------------------- bit stream

function encodeData(bytes, version) {
  const bits = [];
  const push = (val, len) => {
    for (let i = len - 1; i >= 0; i--) bits.push((val >>> i) & 1);
  };

  push(0b0100, 4);                                  // byte mode
  push(bytes.length, version < 10 ? 8 : 16);        // character count
  for (const b of bytes) push(b, 8);

  const capacityBits = dataCapacity(version) * 8;

  // Terminator: up to four zero bits, then pad to a byte boundary.
  for (let i = 0; i < 4 && bits.length < capacityBits; i++) bits.push(0);
  while (bits.length % 8 !== 0) bits.push(0);

  // Then alternating pad codewords until the capacity is filled.
  const pads = [0xec, 0x11];
  for (let i = 0; bits.length < capacityBits; i++) push(pads[i % 2], 8);

  const codewords = [];
  for (let i = 0; i < bits.length; i += 8) {
    let byte = 0;
    for (let j = 0; j < 8; j++) byte = (byte << 1) | bits[i + j];
    codewords.push(byte);
  }
  return codewords;
}

// Split into blocks, compute EC per block, then interleave both groups. The
// interleaving is what makes a burst of damage survivable.
function buildCodewords(bytes, version) {
  const [ecLen, b1, d1, b2, d2] = ECC_M[version];
  const data = encodeData(bytes, version);

  const blocks = [];
  let offset = 0;
  for (let i = 0; i < b1; i++) { blocks.push(data.slice(offset, offset + d1)); offset += d1; }
  for (let i = 0; i < b2; i++) { blocks.push(data.slice(offset, offset + d2)); offset += d2; }

  const ecBlocks = blocks.map((b) => rsEncode(b, ecLen));

  const out = [];
  const maxData = Math.max(d1, d2);
  for (let i = 0; i < maxData; i++) {
    for (const b of blocks) if (i < b.length) out.push(b[i]);
  }
  for (let i = 0; i < ecLen; i++) {
    for (const b of ecBlocks) out.push(b[i]);
  }
  return out;
}

// ---------------------------------------------------------------- matrix

function buildMatrix(version) {
  const size = version * 4 + 17;
  const mods = [];      // null = free, true/false = set
  const fixed = [];     // true where function patterns live
  for (let i = 0; i < size; i++) {
    mods.push(new Array(size).fill(null));
    fixed.push(new Array(size).fill(false));
  }

  const set = (r, c, v) => {
    if (r < 0 || c < 0 || r >= size || c >= size) return;
    mods[r][c] = v;
    fixed[r][c] = true;
  };

  // Finder patterns, plus the light separator around each.
  const finder = (top, left) => {
    for (let r = -1; r <= 7; r++) {
      for (let c = -1; c <= 7; c++) {
        const inRing = (r >= 0 && r <= 6 && (c === 0 || c === 6)) ||
                       (c >= 0 && c <= 6 && (r === 0 || r === 6));
        const inCore = r >= 2 && r <= 4 && c >= 2 && c <= 4;
        set(top + r, left + c, inRing || inCore);
      }
    }
  };
  finder(0, 0);
  finder(0, size - 7);
  finder(size - 7, 0);

  // Timing patterns.
  for (let i = 8; i < size - 8; i++) {
    set(6, i, i % 2 === 0);
    set(i, 6, i % 2 === 0);
  }

  // Alignment patterns, skipping the three that would collide with finders.
  const centres = ALIGN[version];
  for (const r of centres) {
    for (const c of centres) {
      if ((r === 6 && c === 6) || (r === 6 && c === size - 7) || (r === size - 7 && c === 6)) continue;
      for (let dr = -2; dr <= 2; dr++) {
        for (let dc = -2; dc <= 2; dc++) {
          set(r + dr, c + dc, Math.max(Math.abs(dr), Math.abs(dc)) !== 1);
        }
      }
    }
  }

  // Reserve the format areas so data placement skips them. Index 6 is left
  // alone in both directions: those two modules belong to the timing patterns,
  // which run straight through the format band and are not part of it.
  for (let i = 0; i <= 8; i++) {
    if (i === 6) continue;
    set(8, i, false);
    set(i, 8, false);
  }
  for (let i = 0; i < 8; i++) set(8, size - 1 - i, false);   // horizontal copy: 8 modules
  for (let i = 0; i < 7; i++) set(size - 1 - i, 8, false);   // vertical copy: 7 modules

  // The one module that is always dark. Set last, because it sits at
  // (size-8, 8), immediately below the vertical format band, and an
  // off-by-one in that reservation would silently erase it.
  set(size - 8, 8, true);

  // Version information blocks, version 7 and up.
  if (version >= 7) {
    const bits = versionBits(version);
    for (let i = 0; i < 18; i++) {
      const bit = ((bits >> i) & 1) === 1;
      const r = Math.floor(i / 3);
      const c = size - 11 + (i % 3);
      set(r, c, bit);
      set(c, r, bit);
    }
  }

  return { mods, fixed, size };
}

// BCH(18,6) for the version block.
function versionBits(version) {
  let d = version << 12;
  for (let i = 0; i < 6; i++) {
    if (d & (1 << (17 - i))) d ^= 0x1f25 << (5 - i);
  }
  return (version << 12) | d;
}

// BCH(15,5) plus the spec's fixed mask, for the format block.
function formatBits(mask) {
  const ECC_BITS_M = 0b00;
  const data = (ECC_BITS_M << 3) | mask;
  let d = data << 10;
  for (let i = 0; i < 5; i++) {
    if (d & (1 << (14 - i))) d ^= 0x537 << (4 - i);
  }
  return ((data << 10) | d) ^ 0x5412;
}

// Bit 0 is the least significant. The two copies run in opposite directions:
// the vertical one climbs the left edge from the top, the horizontal one runs
// leftward from the right edge. Getting these the wrong way round produces a
// QR that looks perfect and scans as nothing.
function placeFormat(mods, size, mask) {
  const bits = formatBits(mask);
  const bit = (i) => ((bits >> i) & 1) === 1;

  // Copy one wraps the top-left finder: up column 8, then left along row 8.
  // Note it never touches (6,8) or (8,6) — those belong to the timing patterns,
  // which run straight through the format band.
  for (let i = 0; i <= 5; i++) mods[i][8] = bit(i);
  mods[7][8] = bit(6);
  mods[8][8] = bit(7);
  mods[8][7] = bit(8);
  for (let i = 9; i < 15; i++) mods[8][14 - i] = bit(i);

  // Copy two is split: low bits along row 8 at the right edge, high bits down
  // column 8 at the bottom.
  for (let i = 0; i < 8; i++) mods[8][size - 1 - i] = bit(i);
  for (let i = 8; i < 15; i++) mods[size - 15 + i][8] = bit(i);
}

function placeData(mods, fixed, size, codewords) {
  let bitIndex = 0;
  const nextBit = () => {
    if (bitIndex >= codewords.length * 8) return false; // remainder bits are 0
    const byte = codewords[bitIndex >> 3];
    const bit = (byte >> (7 - (bitIndex & 7))) & 1;
    bitIndex++;
    return bit === 1;
  };

  let upward = true;
  // Two-module-wide columns, right to left, skipping the vertical timing line.
  for (let right = size - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5;
    for (let step = 0; step < size; step++) {
      const r = upward ? size - 1 - step : step;
      for (let c of [right, right - 1]) {
        if (fixed[r][c]) continue;
        mods[r][c] = nextBit();
      }
    }
    upward = !upward;
  }
}

const MASKS = [
  (r, c) => (r + c) % 2 === 0,
  (r) => r % 2 === 0,
  (r, c) => c % 3 === 0,
  (r, c) => (r + c) % 3 === 0,
  (r, c) => (Math.floor(r / 2) + Math.floor(c / 3)) % 2 === 0,
  (r, c) => ((r * c) % 2) + ((r * c) % 3) === 0,
  (r, c) => (((r * c) % 2) + ((r * c) % 3)) % 2 === 0,
  (r, c) => (((r + c) % 2) + ((r * c) % 3)) % 2 === 0,
];

// The four penalty rules from the spec. Lowest total wins.
function penalty(m, size) {
  let score = 0;

  // Rule 1: runs of five or more of the same colour.
  const runScore = (get) => {
    let s = 0;
    for (let a = 0; a < size; a++) {
      let run = 1;
      for (let b = 1; b < size; b++) {
        if (get(a, b) === get(a, b - 1)) {
          run++;
        } else {
          if (run >= 5) s += run - 2;
          run = 1;
        }
      }
      if (run >= 5) s += run - 2;
    }
    return s;
  };
  score += runScore((r, c) => m[r][c]);
  score += runScore((c, r) => m[r][c]);

  // Rule 2: 2x2 blocks of one colour.
  for (let r = 0; r < size - 1; r++) {
    for (let c = 0; c < size - 1; c++) {
      const v = m[r][c];
      if (v === m[r][c + 1] && v === m[r + 1][c] && v === m[r + 1][c + 1]) score += 3;
    }
  }

  // Rule 3: finder-like 1:1:3:1:1 patterns with four light modules beside them.
  const P1 = [true, false, true, true, true, false, true, false, false, false, false];
  const P2 = [false, false, false, false, true, false, true, true, true, false, true];
  const matches = (get, a, b) => {
    let ok1 = true, ok2 = true;
    for (let i = 0; i < 11; i++) {
      const v = get(a, b + i);
      if (v !== P1[i]) ok1 = false;
      if (v !== P2[i]) ok2 = false;
    }
    return (ok1 ? 1 : 0) + (ok2 ? 1 : 0);
  };
  for (let r = 0; r < size; r++) {
    for (let c = 0; c + 11 <= size; c++) {
      score += 40 * matches((a, b) => m[a][b], r, c);
      score += 40 * matches((a, b) => m[b][a], r, c);
    }
  }

  // Rule 4: deviation from an even split of dark and light.
  let dark = 0;
  for (let r = 0; r < size; r++) for (let c = 0; c < size; c++) if (m[r][c]) dark++;
  const pct = (dark * 100) / (size * size);
  score += Math.floor(Math.abs(pct - 50) / 5) * 10;

  return score;
}

/**
 * Encode text as a QR matrix.
 * @param {string} text
 * @returns {{size: number, modules: boolean[][], version: number, mask: number}}
 */
function renderWithMask(codewords, version, mask) {
  const { mods, fixed, size } = buildMatrix(version);
  placeData(mods, fixed, size, codewords);
  for (let r = 0; r < size; r++) {
    for (let c = 0; c < size; c++) {
      if (!fixed[r][c] && MASKS[mask](r, c)) mods[r][c] = !mods[r][c];
    }
  }
  placeFormat(mods, size, mask);
  return { size, modules: mods.map((row) => row.map((v) => v === true)) };
}

function encode(text, opts) {
  const bytes = Array.from(Buffer.from(String(text), 'utf8'));
  const version = pickVersion(bytes.length);
  const codewords = buildCodewords(bytes, version);

  // A forced mask exists for the verification harness; normal use picks the
  // lowest-penalty mask, which is what the spec asks for.
  if (opts && opts.mask !== undefined && opts.mask !== null) {
    const r = renderWithMask(codewords, version, opts.mask);
    return { size: r.size, modules: r.modules, version, mask: opts.mask };
  }

  let best = null;
  for (let mask = 0; mask < 8; mask++) {
    const r = renderWithMask(codewords, version, mask);
    const score = penalty(r.modules, r.size);
    if (!best || score < best.score) best = { score, modules: r.modules, size: r.size, mask };
  }

  return { size: best.size, modules: best.modules, version, mask: best.mask };
}

/**
 * Render a QR as a self-contained SVG string.
 * Drawn as one path of rectangles: fewer nodes, and it survives being scaled
 * to whatever a tablet screen happens to be.
 */
function toSVG(text, opts) {
  const o = opts || {};
  const quiet = o.quiet === undefined ? 4 : o.quiet;
  const dark = o.dark || '#23211c';
  const light = o.light || '#ffffff';
  const { size, modules } = encode(text);
  const total = size + quiet * 2;

  let d = '';
  for (let r = 0; r < size; r++) {
    for (let c = 0; c < size; c++) {
      if (modules[r][c]) d += 'M' + (c + quiet) + ' ' + (r + quiet) + 'h1v1h-1z';
    }
  }

  return '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ' + total + ' ' + total +
    '" shape-rendering="crispEdges" role="img" aria-label="QR code">' +
    '<rect width="' + total + '" height="' + total + '" fill="' + light + '"/>' +
    '<path d="' + d + '" fill="' + dark + '"/></svg>';
}

module.exports = { encode, toSVG, byteCapacity };
