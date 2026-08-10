'use strict';

// Builds the GitHub Pages site from public/landing.html.
//
// The landing page is served two ways and they are not the same environment:
//
//   1. By the app itself, at /landing, where the wall is next door and absolute
//      paths like /favicon.svg resolve.
//   2. As a static marketing site on GitHub Pages, where there is no server and
//      no wall to link to. Asset paths are made relative rather than absolute so
//      the output is correct whether it is served from a custom domain at the
//      root (attic.programmershop.in) or from the project path (/attic/) before
//      DNS is pointed.
//
// So this rewrites rather than copies: absolute asset paths become relative, and
// links into a running app become links to the download. One source file, two
// correct outputs, and nothing to keep in sync by hand.

const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const OUT = path.join(ROOT, 'site');
const REPO = 'https://github.com/PrahaladaSumiranTechlabs/attic';
const RELEASES = REPO + '/releases';
const SITE_URL = process.env.ATTIC_SITE_URL || 'https://attic.programmershop.in/';

// Anything that only exists when a server is running. Left pointing at "/" on a
// static host, these would land on the site's own front page and look broken.
const APP_LINKS = {
  '/': RELEASES,
  '/legacy': REPO + '#the-three-tiers',
  '/?eink=1': REPO + '#e-ink',
  '/view': REPO + '#sharing-a-wall-read-only',
  '/connect': REPO + '#connecting-a-device',
};

let html = fs.readFileSync(path.join(ROOT, 'public', 'landing.html'), 'utf8');

// App links first: doing this after the asset pass would leave "/" already
// rewritten to something relative and no longer matchable.
for (const [from, to] of Object.entries(APP_LINKS)) {
  html = html.split('href="' + from + '"').join('href="' + to + '"');
}

// Absolute asset paths -> relative, so the project subpath works.
html = html.replace(/(href|src)="\/([^"/][^"]*)"/g, '$1="$2"');

// Point the canonical and social URLs at the site rather than the repo.
html = html.replace(/<link rel="canonical" href="[^"]*">/,
  '<link rel="canonical" href="' + SITE_URL + '">');
html = html.replace(/<meta property="og:type"/,
  '<meta property="og:url" content="' + SITE_URL + '">\n<meta property="og:type"');

fs.rmSync(OUT, { recursive: true, force: true });
fs.mkdirSync(OUT, { recursive: true });
fs.writeFileSync(path.join(OUT, 'index.html'), html);

for (const asset of ['favicon.svg', 'icon.png']) {
  fs.copyFileSync(path.join(ROOT, 'public', asset), path.join(OUT, asset));
}

// Without this, Pages runs Jekyll and silently drops anything starting with _.
fs.writeFileSync(path.join(OUT, '.nojekyll'), '');

if (process.env.ATTIC_CNAME) {
  fs.writeFileSync(path.join(OUT, 'CNAME'), process.env.ATTIC_CNAME + '\n');
}

// Check that every local reference actually resolves to a file we shipped.
//
// The obvious check — "are there any absolute paths left?" — cannot fail, because
// the rewrite above strips every leading slash first. It would turn an unhandled
// /whatever into a relative whatever and report success while shipping a 404.
// So verify against the output directory instead of the markup.
const refs = (html.match(/(?:href|src)="([^"]+)"/g) || [])
  .map((m) => m.replace(/^(?:href|src)="/, '').replace(/"$/, ''));

const ids = (html.match(/id="([^"]+)"/g) || [])
  .map((m) => m.slice(4, -1));

const broken = [];
for (const ref of refs) {
  if (/^(https?:|mailto:|\/\/)/.test(ref)) continue;
  if (ref.startsWith('#')) {
    if (ids.indexOf(ref.slice(1)) === -1) broken.push(ref + '  (no such id on the page)');
    continue;
  }
  const target = ref.split('#')[0].split('?')[0].replace(/^\.\//, '');
  if (!target) continue;
  if (!fs.existsSync(path.join(OUT, target))) {
    broken.push(ref + '  (no such file in site/)');
  }
}

if (broken.length) {
  console.log('FAIL: these would 404 for a visitor:');
  broken.forEach((b) => console.log('  ' + b));
  process.exit(1);
}

const files = fs.readdirSync(OUT);
console.log('built site/ ->', files.join(', '));
console.log('canonical  ->', SITE_URL);
console.log('checked ' + refs.length + ' references, all resolve');
