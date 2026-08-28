const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  readState:    ()                    => ipcRenderer.invoke('fs:readState'),
  writeState:   (state)               => ipcRenderer.invoke('fs:writeState', state),
  readFile:     (filePath)            => ipcRenderer.invoke('fs:readFile', filePath),
  writeFile:    (filePath, content)   => ipcRenderer.invoke('fs:writeFile', filePath, content),
  autosavePath: (tabId)               => ipcRenderer.invoke('fs:autosavePath', tabId),
  saveAs:       (defaultName)         => ipcRenderer.invoke('dialog:saveAs', defaultName),
  openFile:     ()                    => ipcRenderer.invoke('dialog:openFile'),
  onMenuAction: (cb) => ipcRenderer.on('menu:action', (_e, action) => cb(action)),
});
