'use strict';

// Asserts that everything server.js requires will actually be inside the
// packaged desktop app.
//
// This exists because of a real failure: lib/qr.js was added to the server, the
// standalone server kept working, CI stayed green, and the packaged app shipped
// without it — the window opened onto a server that had died at require(). The
// build's `files` list is a second place to remember things, and this is the
// thing that remembers for you.

const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
const files = (pkg.build && pkg.build.files) || [];
const unpack = (pkg.build && pkg.build.asarUnpack) || [];

// Walk relative requires out from server.js.
const seen = new Set();
const needed = new Set();

function walk(file) {
  const abs = path.resolve(file);
  if (seen.has(abs)) return;
  seen.add(abs);

  let src;
  try {
    src = fs.readFileSync(abs, 'utf8');
  } catch (e) {
    console.log('FAIL: cannot read ' + abs);
    process.exitCode = 1;
    return;
  }

  const rel = path.relative(ROOT, abs).split(path.sep).join('/');
  needed.add(rel);

  const re = /require\(\s*['"](\.[^'"]+)['"]\s*\)/g;
  let m;
  while ((m = re.exec(src)) !== null) {
    let target = path.resolve(path.dirname(abs), m[1]);
    if (!fs.existsSync(target) && fs.existsSync(target + '.js')) target += '.js';
    walk(target);
  }
}

walk(path.join(ROOT, 'server.js'));

// A glob covers a path if the glob's literal prefix matches it. Good enough for
// the handful of patterns a build config ever holds, and it does not pull in a
// glob library to check a config that exists to avoid dependencies.
function covered(rel, patterns) {
  return patterns.some((p) => {
    if (p === rel) return true;
    const star = p.indexOf('*');
    if (star === -1) return false;
    return rel.startsWith(p.slice(0, star));
  });
}

let failures = 0;

for (const rel of [...needed].sort()) {
  const inFiles = covered(rel, files);
  const inUnpack = covered(rel, unpack);

  if (!inFiles) {
    failures++;
    console.log('  FAIL ' + rel + '  -> not matched by build.files; it will be missing from the app');
  } else if (!inUnpack) {
    // The server is forked as a child process, which cannot load anything from
    // inside the asar archive.
    failures++;
    console.log('  FAIL ' + rel + '  -> in build.files but not asarUnpack; fork() cannot load it from the archive');
  } else {
    console.log('  ok   ' + rel);
  }
}

console.log('');
if (failures) {
  console.log(failures + ' file(s) the server needs would not be usable in the packaged app');
  process.exit(1);
}
console.log('all ' + needed.size + ' server files are packaged and unpacked correctly');
