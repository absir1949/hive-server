const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  addProfile: (name, url, type, keepAlive) => ipcRenderer.invoke('profile:add', name, url, type, keepAlive),
  deleteProfile: (profileId) => ipcRenderer.invoke('profile:delete', profileId),
  updateProfile: (profileId, data) => ipcRenderer.invoke('profile:update', profileId, data),
  getAllProfiles: () => ipcRenderer.invoke('profile:getAll'),
  startOrActivate: (profileId) => ipcRenderer.invoke('profile:startOrActivate', profileId),
  getServerUrl: () => ipcRenderer.invoke('server:getUrl'),
  setServerUrl: (url) => ipcRenderer.invoke('server:setUrl', url),
});
