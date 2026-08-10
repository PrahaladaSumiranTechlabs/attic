'use strict';

// Guards a failure mode that is invisible until someone runs the packaged app.
//
// The desktop shell forks server.js, and fork() from Electron runs it on
// Electron's *bundled* Node, not the system Node that CI used to pass the smoke
// test. server.js needs `node:sqlite`, which arrived in Node 22.5. Electron 33
// and earlier bundle Node 20, so the server exits at require() and the app
// opens to a dead window — while every other check in CI stays green.

const { spawnSync } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');

const bin = require(path.join(__dirname, '..', 'node_modules', 'electron'));

if (!fs.existsSync(bin)) {
  console.log('FAIL: electron binary missing at ' + bin);
  process.exit(1);
}

const probe =
  "const v = process.versions.node;" +
  "try { require('node:sqlite'); console.log('OK ' + v); }" +
  "catch (e) { console.log('NOSQLITE ' + v + ' ' + (e.code || e.message)); }";

const r = spawnSync(bin, ['-e', probe], {
  env: Object.assign({}, process.env, { ELECTRON_RUN_AS_NODE: '1' }),
  encoding: 'utf8',
});

const out = ((r.stdout || '') + (r.stderr || '')).trim();
const line = out.split('\n').map((s) => s.trim()).filter((s) => /^(OK|NOSQLITE) /.test(s))[0] || '';

if (line.indexOf('OK ') === 0) {
  console.log("ok   Electron's bundled Node " + line.slice(3) + ' provides node:sqlite');
  process.exit(0);
}

console.log('FAIL: Electron bundles a Node without node:sqlite.');
console.log('      ' + (line || out));
console.log('      Upgrade electron until its bundled Node is >= 22.5.');
process.exit(1);
