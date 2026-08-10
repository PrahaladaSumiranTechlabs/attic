'use strict';

// Attic Desktop — the server, in a window.
//
// The point of this wrapper is to delete a sentence from the install guide.
// "Install Node, clone the repo, run node server.js" loses most people who
// would otherwise happily self-host. Double-clicking an icon does not.
//
// The server itself stays a plain zero-dependency Node script. Electron is a
// shell around it, never a dependency of it — server.js must keep running on
// its own, because that is what anyone deploying to a Pi or a VPS will do.
//
// ELECTRON VERSION IS LOAD-BEARING. fork() runs server.js on Electron's own
// bundled Node, not the system one, and server.js needs `node:sqlite` (Node
// 22.5+). Electron 33 and earlier bundle Node 20, where the server dies at
// require() with ERR_UNKNOWN_BUILTIN_MODULE. Do not downgrade without checking:
//   ELECTRON_RUN_AS_NODE=1 electron -e "require('node:sqlite')"

const { app, BrowserWindow, Tray, Menu, shell, dialog, clipboard } = require('electron');
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');
const { fork } = require('node:child_process');

const net = require('node:net');

// Settings live in a JSON file next to the database, editable from the tray.
// A desktop app has no command line to pass env vars on, so "configurable"
// has to mean a file somebody can actually open.
const DEFAULTS = { port: 8080, host: '0.0.0.0', openWindowOnStart: true };
let settings = Object.assign({}, DEFAULTS);
let PORT = DEFAULTS.port;

function settingsPath() { return path.join(app.getPath('userData'), 'settings.json'); }

function loadSettings() {
  try {
    const raw = fs.readFileSync(settingsPath(), 'utf8');
    settings = Object.assign({}, DEFAULTS, JSON.parse(raw));
  } catch (e) {
    settings = Object.assign({}, DEFAULTS);
    try {
      fs.mkdirSync(app.getPath('userData'), { recursive: true });
      fs.writeFileSync(settingsPath(), JSON.stringify(settings, null, 2));
    } catch (e2) { /* first run on a read-only profile; defaults still work */ }
  }
  // An explicit env var still wins, so scripts and CI can override.
  if (process.env.ATTIC_PORT) settings.port = Number(process.env.ATTIC_PORT);
  return settings;
}

// Rather than dying on "port in use" — the single most likely failure on a
// machine that already runs something on 8080 — walk forward and report where
// we landed.
function findFreePort(start, tries) {
  return new Promise((resolve) => {
    let port = start;
    let left = tries;
    const attempt = () => {
      const probe = net.createServer();
      probe.once('error', () => {
        probe.close();
        if (--left <= 0) return resolve(start);
        port++;
        attempt();
      });
      probe.once('listening', () => probe.close(() => resolve(port)));
      probe.listen(port, '0.0.0.0');
    };
    attempt();
  });
}

// In a packaged build the app lives inside app.asar, and fork() cannot spawn a
// child from inside an archive — the server would exit instantly with "cannot
// find module". server.js and public/ are listed in asarUnpack so they exist as
// real files; this rewrites the path to point at them.
const ROOT = path.join(__dirname, '..').replace('app.asar' + path.sep, 'app.asar.unpacked' + path.sep)
  .replace(/app\.asar$/, 'app.asar.unpacked');

let win = null;
let tray = null;
let server = null;
let quitting = false;

// The whole value of self-hosting is the other devices, so the address they
// need has to be visible without anyone running ipconfig.
function lanAddress() {
  const nets = os.networkInterfaces();
  const candidates = [];
  for (const name of Object.keys(nets)) {
    for (const net of nets[name] || []) {
      if (net.family !== 'IPv4' && net.family !== 4) continue;
      if (net.internal) continue;
      candidates.push({ name, address: net.address });
    }
  }
  // Prefer a private-range address; a VPN or container bridge can otherwise win.
  const priv = candidates.find((c) => /^(192\.168|10\.|172\.(1[6-9]|2\d|3[01])\.)/.test(c.address));
  return (priv || candidates[0] || { address: '127.0.0.1' }).address;
}

function serverURL() { return 'http://127.0.0.1:' + PORT + '/'; }
function shareURL() { return 'http://' + lanAddress() + ':' + PORT + '/'; }

function startServer() {
  // Fork rather than require: a crash in the server takes down a child process
  // we can restart, not the whole app.
  server = fork(path.join(ROOT, 'server.js'), [], {
    env: Object.assign({}, process.env, {
      PORT: String(PORT),
      HOST: settings.host || '0.0.0.0',
      // Keep the database beside the user's data, not inside the app bundle,
      // which is read-only once packaged.
      NOTER_DB: path.join(app.getPath('userData'), 'attic.db'),
    }),
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  });

  server.stdout.on('data', (d) => process.stdout.write('[server] ' + d));
  server.stderr.on('data', (d) => process.stderr.write('[server] ' + d));

  // Without this, a fork that never spawns emits an unhandled 'error' and the
  // app sits there looking alive with nothing behind it.
  server.on('error', (err) => {
    console.error('[attic] could not start the server process:', err);
    if (quitting) return;
    dialog.showErrorBox('Attic could not start',
      'The server process failed to launch.\n\n' + err.message +
      '\n\nLooked for: ' + path.join(ROOT, 'server.js'));
    app.exit(1);
  });

  server.on('exit', (code) => {
    if (quitting) return;
    // Log before the dialog: showErrorBox is modal, so on a headless or
    // unattended machine the reason would otherwise never be visible.
    console.error('[attic] server exited with code ' + code);
    dialog.showErrorBox('Attic stopped',
      'The Attic server exited (code ' + code + '). The app will close.');
    app.exit(1);
  });
}

// The server needs a moment to bind before the window loads, and a failed first
// load shows a browser error page that never retries. So retry the load itself.
function loadWhenReady(attempt) {
  attempt = attempt || 0;
  win.loadURL(serverURL()).catch(() => {
    if (attempt > 40) {
      dialog.showErrorBox('Attic could not start',
        'The server did not come up on port ' + PORT + '.');
      app.quit();
      return;
    }
    setTimeout(() => loadWhenReady(attempt + 1), 250);
  });
}

function createWindow() {
  win = new BrowserWindow({
    width: 1180,
    height: 820,
    minWidth: 480,
    minHeight: 400,
    backgroundColor: '#f4f1ea',
    title: 'Attic',
    icon: path.join(ROOT, 'public', 'icon.png'),
    webPreferences: {
      // Nothing in the page needs Node, and the page renders text other people
      // typed. Keep the renderer sandboxed.
      nodeIntegration: false,
      contextIsolation: true,
    },
  });

  win.setMenuBarVisibility(false);
  loadWhenReady();

  // Links to anywhere but our own server open in the real browser.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (url.indexOf(serverURL()) !== 0) shell.openExternal(url);
    return { action: 'deny' };
  });

  // Closing the window leaves the server running in the tray: other devices on
  // the LAN are still using it, and closing a window should not cut them off.
  win.on('close', (e) => {
    if (quitting) return;
    e.preventDefault();
    win.hide();
  });
}

function createTray() {
  const iconPath = path.join(ROOT, 'public', 'icon.png');
  try {
    tray = new Tray(iconPath);
  } catch (e) {
    return; // no tray on this platform/session; the window still works
  }

  const menu = Menu.buildFromTemplate([
    { label: 'Attic — ' + shareURL(), enabled: false },
    { type: 'separator' },
    { label: 'Open wall', click: () => { win.show(); win.focus(); } },
    {
      label: 'Connect a device (QR)…',
      click: () => shell.openExternal('http://127.0.0.1:' + PORT + '/connect'),
    },
    { label: 'Copy address for other devices', click: () => clipboard.writeText(shareURL()) },
    { label: 'Open in browser', click: () => shell.openExternal(shareURL()) },
    { type: 'separator' },
    {
      label: 'Settings (port, host)…',
      click: () => {
        // Opening the file beats building a preferences window for two fields,
        // and it is honest about where the setting actually lives.
        shell.openPath(settingsPath()).then(() => {
          dialog.showMessageBox({
            type: 'info',
            title: 'Attic settings',
            message: 'Edit settings.json, then restart Attic for it to take effect.',
            detail: settingsPath(),
            buttons: ['OK'],
          });
        });
      },
    },
    {
      label: 'Restart Attic',
      click: () => { app.relaunch(); quitting = true; app.exit(0); },
    },
    { type: 'separator' },
    { label: 'Quit Attic', click: () => { quitting = true; app.quit(); } },
  ]);

  tray.setToolTip('Attic — ' + shareURL());
  tray.setContextMenu(menu);
  tray.on('double-click', () => { win.show(); win.focus(); });
}

// One server, one port. A second instance would fail to bind anyway.
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (win) { win.show(); win.focus(); }
  });

  app.whenReady().then(async () => {
    loadSettings();
    PORT = await findFreePort(Number(settings.port) || DEFAULTS.port, 20);
    if (PORT !== Number(settings.port)) {
      console.log('[attic] port ' + settings.port + ' was busy; using ' + PORT);
    }

    startServer();
    createWindow();
    createTray();

    app.on('activate', () => {
      if (win) { win.show(); win.focus(); }
    });
  });

  app.on('before-quit', () => { quitting = true; });

  app.on('will-quit', () => {
    if (server && !server.killed) server.kill();
  });

  // Deliberately not app.quit() on window-all-closed: the tray keeps serving.
  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin' && !tray) app.quit();
  });
}
