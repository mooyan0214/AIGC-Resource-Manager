const { contextBridge, ipcRenderer } = require('electron')

const resourceApi = {
  selectDirectory: () => ipcRenderer.invoke('models:selectDirectory'),
  scanDirectory: modelsRoot => ipcRenderer.invoke('models:scanDirectory', modelsRoot),
  load: () => ipcRenderer.invoke('resources:load'),
  save: data => ipcRenderer.invoke('resources:save', data),
  fetchBilibiliInfo: payload => ipcRenderer.invoke('bilibili:fetchInfo', payload),
  scanGalleryDirectory: galleryRoot => ipcRenderer.invoke('gallery:scanDirectory', galleryRoot),
  copyImage: imagePath => ipcRenderer.invoke('gallery:copyImage', imagePath),
  deleteImage: imagePath => ipcRenderer.invoke('gallery:deleteImage', imagePath),
  deleteImages: imagePaths => ipcRenderer.invoke('gallery:deleteImages', imagePaths),
  copyImagesToDirectory: payload => ipcRenderer.invoke('gallery:copyImagesToDirectory', payload),
  moveImagesToDirectory: payload => ipcRenderer.invoke('gallery:moveImagesToDirectory', payload),
  openGalleryPath: galleryPath => ipcRenderer.invoke('gallery:openPath', galleryPath),
  revealGalleryItem: itemPath => ipcRenderer.invoke('gallery:revealItem', itemPath),
  importGalleryImages: payload => ipcRenderer.invoke('gallery:importImages', payload),
  readGalleryPrompt: imagePath => ipcRenderer.invoke('gallery:readPrompt', imagePath),
  readGalleryImage: imagePath => ipcRenderer.invoke('gallery:readImage', imagePath),
  submitFeedback: payload => ipcRenderer.invoke('feedback:submit', payload),
  showConfirmDialog: payload => ipcRenderer.invoke('dialog:confirm', payload),
  showAlertDialog: payload => ipcRenderer.invoke('dialog:alert', payload),
}

contextBridge.exposeInMainWorld('localModels', resourceApi)
contextBridge.exposeInMainWorld('resourceApi', resourceApi)

console.log('[preload] Electron preload loaded')

