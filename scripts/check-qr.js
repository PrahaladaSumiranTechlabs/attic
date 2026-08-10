'use strict';

// Compares lib/qr.js against the Python `qrcode` reference implementation,
// module for module, across a spread of inputs.
//
// A QR encoder is the kind of code that produces something QR-shaped and
// completely unscannable, and you cannot tell by looking. This is the only
// honest way to know it works without pointing a phone at the screen.
//
// The reference picks its own mask, and different versions of it disagree about
// whether a caller may force one. So rather than forcing a mask and hoping it
// took, this asks: does ANY of our eight masks reproduce the reference exactly?
// A match proves the encoding — data, error correction, and function patterns —
// is right, and separately tells us whether our mask choice agreed with theirs.
//
// Needs the reference on a Python interpreter:  pip install qrcode
// Point QR_PYTHON at a specific one. Skips (exit 0) when it is unavailable, so
// it never blocks a build that cannot install it.

const { spawnSync } = require('node:child_process');
const path = require('node:path');
const qr = require(path.join(__dirname, '..', 'lib', 'qr.js'));

const PY = process.env.QR_PYTHON || 'python';

const CASES = [
  'http://192.168.1.42:8080/',
  'http://192.168.1.42:8080/kitchen',
  'http://10.0.0.7:3000/dusty-lantern-402',
  'a',
  'attic',
  'http://192.168.100.200:65535/a-very-long-room-name-that-goes-on',
  'x'.repeat(60),
  'x'.repeat(120),
  'http://[::1]:8080/ ~ ünïcödé',
];

// Byte mode is forced on the reference. Left to itself it splits input into
// several segments and switches modes mid-string — "http://" as bytes, then
// "192.168.1.42:8080/" as alphanumeric, since digits, dots, colons and slashes
// all live in the alphanumeric character set. That is a denser encoding and an
// equally valid QR; we simply do not implement it. Comparing against it would
// be comparing two different (both correct) answers.
const PY_SRC = `
import sys, json
try:
    import qrcode
    from qrcode.constants import ERROR_CORRECT_M
    from qrcode.util import QRData, MODE_8BIT_BYTE
except Exception:
    print("NOREF"); sys.exit(0)

out = []
for item in json.loads(sys.stdin.read()):
    q = qrcode.QRCode(version=item["version"], error_correction=ERROR_CORRECT_M,
                      box_size=1, border=0)
    q.add_data(QRData(item["text"].encode("utf-8"), mode=MODE_8BIT_BYTE), optimize=0)
    q.make(fit=False)
    out.append(["".join("1" if c else "0" for c in row) for row in q.get_matrix()])
print(json.dumps(out))
`;

const ours = CASES.map((text) => {
  const auto = qr.encode(text);
  return { text, version: auto.version, bestMask: auto.mask };
});

const proc = spawnSync(PY, ['-c', PY_SRC], {
  input: JSON.stringify(ours.map((o) => ({ text: o.text, version: o.version }))),
  encoding: 'utf8',
  // Windows Python still reads stdin in the locale encoding, which mangles any
  // non-ASCII case into a different byte sequence and fails a comparison that
  // has nothing wrong with it.
  env: Object.assign({}, process.env, { PYTHONUTF8: '1', PYTHONIOENCODING: 'utf-8' }),
});

const stdout = (proc.stdout || '').trim();

if (proc.error || stdout === 'NOREF' || !stdout) {
  console.log('skip: Python `qrcode` reference not available — QR left unverified');
  console.log('      install it with: pip install qrcode');
  process.exit(0);
}

let reference;
try {
  reference = JSON.parse(stdout.split('\n').pop());
} catch (e) {
  console.log('skip: could not parse reference output');
  console.log(stdout.slice(0, 400));
  process.exit(0);
}

function compare(rows, ref) {
  if (!ref || ref.length !== rows.length) return Infinity;
  let diff = 0;
  for (let r = 0; r < ref.length; r++) {
    for (let c = 0; c < ref[r].length; c++) if (ref[r][c] !== rows[r][c]) diff++;
  }
  return diff;
}

let failures = 0;
let maskDisagreements = 0;

ours.forEach((o, i) => {
  const ref = reference[i];
  const label = 'v' + o.version + '  ' +
    (o.text.length > 34 ? o.text.slice(0, 31) + '...' : o.text);

  let matched = -1;
  let closest = Infinity;
  for (let mask = 0; mask < 8; mask++) {
    const m = qr.encode(o.text, { mask });
    const rows = m.modules.map((r) => r.map((v) => (v ? '1' : '0')).join(''));
    const diff = compare(rows, ref);
    if (diff < closest) closest = diff;
    if (diff === 0) { matched = mask; break; }
  }

  if (matched === -1) {
    failures++;
    console.log('  FAIL ' + label + '  -> no mask reproduces the reference (closest: ' +
      closest + ' modules)');
    return;
  }

  if (matched === o.bestMask) {
    console.log('  ok   ' + label + '  (mask ' + matched + ')');
  } else {
    maskDisagreements++;
    console.log('  ok   ' + label + '  (encoding matches on mask ' + matched +
      '; we would pick ' + o.bestMask + ')');
  }
});

console.log('');
if (failures) {
  console.log(failures + ' of ' + ours.length + ' QR codes do not match the reference');
  process.exit(1);
}
console.log('all ' + ours.length + ' QR codes match the reference exactly');
if (maskDisagreements) {
  // Not a failure: every mask yields a valid, scannable code, and the penalty
  // rules only decide which is prettiest. Worth knowing about, not worth failing.
  console.log(maskDisagreements + ' picked a different mask than the reference ' +
    '(still valid — mask choice is cosmetic)');
}
