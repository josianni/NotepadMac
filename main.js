const { app, BrowserWindow, ipcMain, dialog, Menu, Tray, protocol, net } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');

const AUTOSAVE_DIR = path.join(os.homedir(), 'NotepadMac');
const STATE_FILE = path.join(os.homedir(), '.notepadmac-state.json');

let win;
let tray;

function ensureAutosaveDir() {
  if (!fs.existsSync(AUTOSAVE_DIR)) {
    fs.mkdirSync(AUTOSAVE_DIR, { recursive: true });
  }
}

function createTray() {
  tray = new Tray(path.join(__dirname, 'trayIconTemplate.png'));
  tray.setToolTip('NotepadMac');
  tray.on('click', () => {
    if (!win || win.isDestroyed()) {
      createWindow();
    } else if (win.isVisible()) {
      win.hide();
    } else {
      win.show();
      win.focus();
    }
  });
  const contextMenu = Menu.buildFromTemplate([
    { label: 'Abrir NotepadMac', click: () => {
      if (!win || win.isDestroyed()) createWindow();
      else { win.show(); win.focus(); }
    }},
    { type: 'separator' },
    { label: 'Sair', click: () => app.quit() },
  ]);
  tray.setContextMenu(contextMenu);
}

function createWindow() {
  win = new BrowserWindow({
    width: 1280,
    height: 800,
    titleBarStyle: 'hiddenInset',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  win.loadURL('app://renderer/index.html');

  win.on('close', (e) => {
    e.preventDefault();
    win.hide();
  });

  buildMenu();
}

function buildMenu() {
  const send = (action) => win.webContents.send('menu:action', action);

  const template = [
    {
      label: 'File',
      submenu: [
        { label: 'New Tab', accelerator: 'CmdOrCtrl+T', click: () => send('new-tab') },
        { label: 'Open File…', accelerator: 'CmdOrCtrl+O', click: () => send('open-file') },
        { type: 'separator' },
        { label: 'Save', accelerator: 'CmdOrCtrl+S', click: () => send('save') },
        { label: 'Save As…', accelerator: 'CmdOrCtrl+Shift+S', click: () => send('save-as') },
        { type: 'separator' },
        { label: 'Close Tab', accelerator: 'CmdOrCtrl+W', click: () => send('close-tab') },
        { type: 'separator' },
        { label: 'Quit', accelerator: 'CmdOrCtrl+Q', click: () => app.quit() },
      ],
    },
    {
      label: 'Edit',
      submenu: [
        { role: 'undo' },
        { role: 'redo' },
        { type: 'separator' },
        { role: 'cut' },
        { role: 'copy' },
        { role: 'paste' },
        { role: 'selectAll' },
        { type: 'separator' },
        { label: 'Format JSON', accelerator: 'CmdOrCtrl+Shift+F', click: () => send('format-json') },
      ],
    },
    {
      label: 'Find',
      submenu: [
        { label: 'Find / Replace…', accelerator: 'CmdOrCtrl+F', click: () => send('find') },
        { label: 'Find in All Tabs…', accelerator: 'CmdOrCtrl+Alt+Shift+F', click: () => send('find-all') },
      ],
    },
    {
      label: 'View',
      submenu: [
        { label: 'Compare Tabs…', click: () => send('compare') },
        { type: 'separator' },
        { role: 'toggleDevTools' },
        { role: 'reload' },
      ],
    },
    {
      label: 'Window',
      submenu: [
        { role: 'minimize' },
        { role: 'zoom' },
        { role: 'close' },
      ],
    },
  ];

  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

// IPC handlers
ipcMain.handle('fs:readState', () => {
  try {
    return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
  } catch {
    return null;
  }
});

ipcMain.handle('fs:writeState', (_e, state) => {
  const tmp = STATE_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2), 'utf8');
  fs.renameSync(tmp, STATE_FILE);
});

ipcMain.handle('fs:readFile', (_e, filePath) => {
  try {
    return fs.readFileSync(filePath, 'utf8');
  } catch {
    return '';
  }
});

ipcMain.handle('fs:writeFile', (_e, filePath, content) => {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content, 'utf8');
});

ipcMain.handle('fs:autosavePath', (_e, tabId) => {
  return path.join(AUTOSAVE_DIR, `${tabId}.txt`);
});

ipcMain.handle('dialog:saveAs', async (_e, defaultName) => {
  const { filePath, canceled } = await dialog.showSaveDialog(win, {
    defaultPath: path.join(os.homedir(), defaultName || 'untitled.txt'),
  });
  return canceled ? null : filePath;
});

ipcMain.handle('dialog:openFile', async () => {
  const { filePaths, canceled } = await dialog.showOpenDialog(win, {
    properties: ['openFile'],
  });
  if (canceled || !filePaths.length) return null;
  const filePath = filePaths[0];
  const content = fs.readFileSync(filePath, 'utf8');
  return { path: filePath, content };
});

app.whenReady().then(() => {
  ensureAutosaveDir();
  app.dock.hide();

  // Register app:// protocol — serves renderer/ files (bundle.js, style.css, index.html)
  protocol.handle('app', (request) => {
    const url = new URL(request.url);
    const segments = [url.hostname, ...url.pathname.split('/').filter(Boolean)];
    const filePath = path.join(__dirname, ...segments);
    return net.fetch('file://' + filePath);
  });

  createTray();
  createWindow();

  app.on('activate', () => {
    if (win && !win.isDestroyed()) {
      win.show();
      win.focus();
    }
  });
});

app.on('window-all-closed', () => {
  // Não fechar — o app vive na menu bar
});
