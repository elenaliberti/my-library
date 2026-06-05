const { contextBridge, ipcRenderer } = require('electron')
contextBridge.exposeInMainWorld('api', {
  loadData:       ()      => ipcRenderer.invoke('data:load'),
  saveData:       (items) => ipcRenderer.invoke('data:save', items),
  exportPath:     ()      => ipcRenderer.invoke('data:export-path'),
  openDataFolder: ()      => ipcRenderer.invoke('data:open-location'),
  fetchAO3:       (url)   => ipcRenderer.invoke('ao3:fetch', url),
  openExternal:   (url)   => ipcRenderer.invoke('shell:open-external', url),
  gitStatus:      ()      => ipcRenderer.invoke('git:status'),
  gitBackup:      ()      => ipcRenderer.invoke('git:backup'),
})
