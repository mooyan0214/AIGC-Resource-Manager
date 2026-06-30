const { contextBridge, ipcRenderer } = require('electron')

const localModelsApi = {
  selectDirectory: () => ipcRenderer.invoke('models:selectDirectory'),
  scanDirectory: (modelsRoot: string) => ipcRenderer.invoke('models:scanDirectory', modelsRoot),
  load: () => ipcRenderer.invoke('resources:load'),
  save: (data: unknown) => ipcRenderer.invoke('resources:save', data),
  fetchBilibiliInfo: (payload: { url: string }) => ipcRenderer.invoke('bilibili:fetchInfo', payload),
  scanGalleryDirectory: (galleryRoot: string) => ipcRenderer.invoke('gallery:scanDirectory', galleryRoot),
  copyImage: (imagePath: string) => ipcRenderer.invoke('gallery:copyImage', imagePath),
  deleteImage: (imagePath: string) => ipcRenderer.invoke('gallery:deleteImage', imagePath),
  deleteImages: (imagePaths: string[]) => ipcRenderer.invoke('gallery:deleteImages', imagePaths),
  copyImagesToDirectory: (payload: { targetDirectory?: string; paths?: string[] }) =>
    ipcRenderer.invoke('gallery:copyImagesToDirectory', payload),
  moveImagesToDirectory: (payload: { targetDirectory?: string; paths?: string[] }) =>
    ipcRenderer.invoke('gallery:moveImagesToDirectory', payload),
  openGalleryPath: (galleryPath: string) => ipcRenderer.invoke('gallery:openPath', galleryPath),
  revealGalleryItem: (itemPath: string) => ipcRenderer.invoke('gallery:revealItem', itemPath),
  importGalleryImages: (payload: { targetDirectory?: string; paths?: string[] }) =>
    ipcRenderer.invoke('gallery:importImages', payload),
  readGalleryPrompt: (imagePath: string) => ipcRenderer.invoke('gallery:readPrompt', imagePath),
  readGalleryImage: (imagePath: string) => ipcRenderer.invoke('gallery:readImage', imagePath),
  submitFeedback: (payload: { content?: string; page?: string }) => ipcRenderer.invoke('feedback:submit', payload),
  showConfirmDialog: (payload: {
    title?: string
    message?: string
    detail?: string
    confirmText?: string
    cancelText?: string
  }) => ipcRenderer.invoke('dialog:confirm', payload),
  showAlertDialog: (payload: {
    title?: string
    message?: string
    detail?: string
    buttonText?: string
  }) => ipcRenderer.invoke('dialog:alert', payload),
}

contextBridge.exposeInMainWorld('localModels', localModelsApi)
contextBridge.exposeInMainWorld('resourceApi', localModelsApi)

console.log('[preload] Electron preload loaded')

