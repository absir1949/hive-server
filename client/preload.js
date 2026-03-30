const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  addProfile: (name, url) => ipcRenderer.invoke('profile:add', name, url),
  deleteProfile: (profileId) => ipcRenderer.invoke('profile:delete', profileId),
  updateProfile: (profileId, data) => ipcRenderer.invoke('profile:update', profileId, data),
  getAllProfiles: () => ipcRenderer.invoke('profile:getAll'),
  startOrActivate: (profileId) => ipcRenderer.invoke('profile:startOrActivate', profileId),
});
