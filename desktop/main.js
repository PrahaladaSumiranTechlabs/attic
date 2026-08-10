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
const { fork } = require('node:child_process');

const PORT = Number(process.env.ATTIC_PORT || 8080);
const ROOT = path.join(__dirname, '..');

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
      HOST: '0.0.0.0',
      // Keep the database beside the user's data, not inside the app bundle,
      // which is read-only once packaged.
      NOTER_DB: path.join(app.getPath('userData'), 'attic.db'),
    }),
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  });

  server.stdout.on('data', (d) => process.stdout.write('[server] ' + d));
  server.stderr.on('data', (d) => process.stderr.write('[server] ' + d));

  server.on('exit', (code) => {
    if (quitting) return;
    dialog.showErrorBox('Attic stopped',
      'The Attic server exited (code ' + code + '). The app will close.');
    app.quit();
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
    { label: 'Copy address for other devices', click: () => clipboard.writeText(shareURL()) },
    { label: 'Open in browser', click: () => shell.openExternal(shareURL()) },
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

  app.whenReady().then(() => {
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
