const { contextBridge, ipcRenderer } = require('electron')
contextBridge.exposeInMainWorld('api', {
  loadData:       ()      => ipcRenderer.invoke('data:load'),
  saveData:       (data)  => ipcRenderer.invoke('data:save', data),
  exportPath:     ()      => ipcRenderer.invoke('data:export-path'),
  openDataFolder: ()      => ipcRenderer.invoke('data:open-location'),
  fetchAO3:       (url)   => ipcRenderer.invoke('ao3:fetch', url),
  fetchFFNet:     (url)   => ipcRenderer.invoke('ffnet:fetch', url),
  ao3Login:       ()      => ipcRenderer.invoke('ao3:login'),
  ao3LoggedIn:    ()      => ipcRenderer.invoke('ao3:logged-in'),
  openExternal:   (url)   => ipcRenderer.invoke('shell:open-external', url),
  gitStatus:      ()      => ipcRenderer.invoke('git:status'),
  gitBackup:      ()      => ipcRenderer.invoke('git:backup'),
  pullData:       ()      => ipcRenderer.invoke('git:pull-data'),
  fetchBook:      (q)     => ipcRenderer.invoke('books:fetch', q),
})
