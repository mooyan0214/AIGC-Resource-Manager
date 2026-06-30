const { app, BrowserWindow, Menu, screen, dialog, ipcMain, shell, clipboard, nativeImage } = require('electron')
const path = require('node:path')
const fs = require('node:fs/promises')
const { createHash } = require('node:crypto')

const IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.webp', '.bmp', '.gif'])
const FEEDBACK_WEBHOOK_URL =
  'https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=bd0a28ce-4372-4c03-b376-bc180611b40d'

const isDev = !app.isPackaged
const APP_STORAGE_DIR_NAME = 'AIGC-Resource-Manager'

function getStorageRootDirectory() {
  return app.isPackaged
    ? path.join(app.getPath('appData'), APP_STORAGE_DIR_NAME)
    : path.join(app.getAppPath(), APP_STORAGE_DIR_NAME)
}

function getDataDirectory() {
  return path.join(getStorageRootDirectory(), 'data')
}

function getResourcesFilePath() {
  return path.join(getDataDirectory(), 'resources.json')
}

async function ensureDataDirectory() {
  await fs.mkdir(getDataDirectory(), { recursive: true })
}

function getCacheDirectory() {
  return path.join(getStorageRootDirectory(), 'cache')
}

async function ensureCacheDirectory() {
  await fs.mkdir(getCacheDirectory(), { recursive: true })
}

async function scanDirectoryTree(directoryPath) {
  const stat = await fs.stat(directoryPath)
  const name = path.basename(directoryPath)

  if (!stat.isDirectory()) {
    return {
      id: directoryPath,
      name,
      path: directoryPath,
      type: 'file',
      size: stat.size,
      modifiedAt: stat.mtime.toLocaleString(),
    }
  }

  const entries = await fs.readdir(directoryPath, { withFileTypes: true })
  const children = []

  for (const entry of entries) {
    const entryPath = path.join(directoryPath, entry.name)

    try {
      children.push(await scanDirectoryTree(entryPath))
    } catch {
      children.push({
        id: entryPath,
        name: entry.name,
        path: entryPath,
        type: entry.isDirectory() ? 'folder' : 'file',
        children: entry.isDirectory() ? [] : undefined,
      })
    }
  }

  children.sort((first, second) => {
    if (first.type !== second.type) {
      return first.type === 'folder' ? -1 : 1
    }

    return first.name.localeCompare(second.name, 'zh-CN')
  })

  return {
    id: directoryPath,
    name,
    path: directoryPath,
    type: 'folder',
    children,
  }
}

function isImageFile(filePath) {
  return IMAGE_EXTENSIONS.has(path.extname(filePath).toLowerCase())
}

function normalizePromptText(content) {
  if (!content) {
    return ''
  }

  const cleanContent = String(content).trim()

  if (!cleanContent) {
    return ''
  }

  const directTextMatch = cleanContent.match(/"inputs"\s*:\s*\{[\s\S]*?"text"\s*:\s*"([\s\S]*?)"\s*(?:,|\})/)

  if (directTextMatch?.[1]) {
    try {
      return JSON.parse(`"${directTextMatch[1]}"`).trim()
    } catch {
      return directTextMatch[1].trim()
    }
  }

  try {
    const parsed = JSON.parse(cleanContent)
    const extractedPrompt =
      parsed?.inputs?.text ||
      parsed?.text ||
      parsed?.prompt ||
      parsed?.parameters?.inputs?.text ||
      parsed?.node?.inputs?.text

    if (typeof extractedPrompt === 'string' && extractedPrompt.trim()) {
      return extractedPrompt.trim()
    }

    return ''
  } catch {
    return cleanContent
      .replace(/```json|```/gi, '')
      .replace(/^\s*"?(inputs|text|prompt)"?\s*:\s*/gim, '')
      .trim()
  }
}

function getMimeType(filePath) {
  const extension = path.extname(filePath).toLowerCase()

  if (extension === '.png') return 'image/png'
  if (extension === '.jpg' || extension === '.jpeg') return 'image/jpeg'
  if (extension === '.webp') return 'image/webp'
  if (extension === '.gif') return 'image/gif'
  if (extension === '.bmp') return 'image/bmp'

  return 'application/octet-stream'
}

async function createImageDataUrl(filePath) {
  const buffer = await fs.readFile(filePath)
  return `data:${getMimeType(filePath)};base64,${buffer.toString('base64')}`
}

async function createThumbnailDataUrl(filePath) {
  await ensureCacheDirectory()

  const stat = await fs.stat(filePath)
  const cacheKey = createHash('sha1')
    .update(`${filePath}|${stat.size}|${stat.mtimeMs}`)
    .digest('hex')
  const cacheFilePath = path.join(getCacheDirectory(), `${cacheKey}.jpg`)

  try {
    const cachedBuffer = await fs.readFile(cacheFilePath)
    return `data:image/jpeg;base64,${cachedBuffer.toString('base64')}`
  } catch {
    const image = nativeImage.createFromPath(filePath)

    if (image.isEmpty()) {
      return createImageDataUrl(filePath)
    }

    const thumbnail = image.resize({ width: 320, quality: 'good' })
    const thumbnailBuffer = thumbnail.toJPEG(50)

    await fs.writeFile(cacheFilePath, thumbnailBuffer)

    return `data:image/jpeg;base64,${thumbnailBuffer.toString('base64')}`
  }
}

function extractPngTextChunks(buffer) {
  const pngSignature = '89504e470d0a1a0a'

  if (!buffer || buffer.length < 8 || buffer.subarray(0, 8).toString('hex') !== pngSignature) {
    return []
  }

  const entries = []
  let offset = 8

  while (offset + 8 <= buffer.length) {
    const chunkLength = buffer.readUInt32BE(offset)
    const chunkType = buffer.toString('ascii', offset + 4, offset + 8)
    const dataStart = offset + 8
    const dataEnd = dataStart + chunkLength

    if (dataEnd + 4 > buffer.length) {
      break
    }

    if (chunkType === 'tEXt') {
      const nullIndex = buffer.indexOf(0, dataStart)

      if (nullIndex > dataStart && nullIndex < dataEnd) {
        const keyword = buffer.toString('utf8', dataStart, nullIndex)
        const value = buffer.toString('utf8', nullIndex + 1, dataEnd)
        entries.push({ keyword, value })
      }
    }

    if (chunkType === 'IEND') {
      break
    }

    offset = dataEnd + 4
  }

  return entries
}

async function readPromptFromImage(imagePath) {
  try {
    const extension = path.extname(imagePath).toLowerCase()

    if (extension === '.png') {
      const buffer = await fs.readFile(imagePath)
      const textEntries = extractPngTextChunks(buffer)
      const preferredEntry = textEntries.find((entry) =>
        ['prompt', 'parameters', 'workflow'].includes(entry.keyword.toLowerCase()),
      )

      if (preferredEntry?.value) {
        return normalizePromptText(preferredEntry.value)
      }

      if (textEntries.length > 0) {
        return normalizePromptText(textEntries.map((entry) => `${entry.keyword}: ${entry.value}`).join('\n\n'))
      }
    }

    const sidecarPath = `${imagePath}.txt`
    const sidecarContent = await fs.readFile(sidecarPath, 'utf-8')
    return normalizePromptText(sidecarContent)
  } catch {
    return ''
  }
}

async function collectGalleryImages(directoryPath) {
  const entries = await fs.readdir(directoryPath, { withFileTypes: true })
  const items = []

  for (const entry of entries) {
    const entryPath = path.join(directoryPath, entry.name)

    if (entry.isDirectory()) {
      try {
        const stat = await fs.stat(entryPath)
        items.push({
          id: entryPath,
          type: 'folder',
          name: entry.name,
          path: entryPath,
          prompt: '',
          modifiedAt: stat.mtime.toLocaleString(),
          modifiedTimestamp: stat.mtimeMs,
        })
      } catch {
        items.push({
          id: entryPath,
          type: 'folder',
          name: entry.name,
          path: entryPath,
          prompt: '',
        })
      }
      continue
    }

    if (!isImageFile(entryPath)) {
      continue
    }

    try {
      const stat = await fs.stat(entryPath)
      const thumbnailDataUrl = await createThumbnailDataUrl(entryPath)
      items.push({
        id: entryPath,
        type: 'file',
        name: entry.name,
        path: entryPath,
        imageUrl: '',
        thumbnailUrl: thumbnailDataUrl,
        size: stat.size,
        modifiedAt: stat.mtime.toLocaleString(),
        modifiedTimestamp: stat.mtimeMs,
      })
    } catch {
      const fallbackImageUrl = await createImageDataUrl(entryPath).catch(() => '')
      items.push({
        id: entryPath,
        type: 'file',
        name: entry.name,
        path: entryPath,
        imageUrl: fallbackImageUrl,
        thumbnailUrl: fallbackImageUrl,
        prompt: '',
      })
    }
  }

  return items
}

function registerModelIpcHandlers() {
  ipcMain.handle('models:selectDirectory', async () => {
    const result = await dialog.showOpenDialog({
      title: '选择资源目录',
      properties: ['openDirectory'],
    })

    if (result.canceled) {
      return null
    }

    return result.filePaths[0]
  })

  ipcMain.handle('models:scanDirectory', async (_event, modelsRoot) => {
    const cleanPath = String(modelsRoot || '').trim()

    if (!cleanPath) {
      throw new Error('目录路径不能为空')
    }

    const tree = await scanDirectoryTree(cleanPath)
    return [tree]
  })
}

function registerResourceStorageHandlers() {
  ipcMain.handle('resources:load', async () => {
    try {
      const content = await fs.readFile(getResourcesFilePath(), 'utf-8')
      return JSON.parse(content)
    } catch {
      return null
    }
  })

  ipcMain.handle('resources:save', async (_event, data) => {
    await ensureDataDirectory()

    const payload = {
      ...data,
      updatedAt: new Date().toISOString(),
    }

    await fs.writeFile(getResourcesFilePath(), JSON.stringify(payload, null, 2), 'utf-8')

    return {
      success: true,
      filePath: getResourcesFilePath(),
    }
  })
}

function getBilibiliVideoQuery(input) {
  const cleanInput = String(input || '').trim()
  const bvMatch = cleanInput.match(/BV[a-zA-Z0-9]+/)
  if (bvMatch) {
    return `bvid=${encodeURIComponent(bvMatch[0])}`
  }
  const avMatch = cleanInput.match(/av(\d+)/i)
  if (avMatch?.[1]) {
    return `aid=${encodeURIComponent(avMatch[1])}`
  }
  return ''
}
function registerBilibiliHandlers() {
  ipcMain.handle('bilibili:fetchInfo', async (_event, payload) => {
    const query = getBilibiliVideoQuery(payload?.url || '')
    if (!query) {
      throw new Error('没有识别到 BV 号或 AV 号')
    }
    const response = await fetch(`https://api.bilibili.com/x/web-interface/view?${query}`, {
      headers: {
        Referer: 'https://www.bilibili.com/',
        'User-Agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36',
      },
    })
    if (!response.ok) {
      throw new Error(`获取视频信息失败：HTTP ${response.status}`)
    }
    const result = await response.json()
    if (result.code !== 0 || !result.data) {
      throw new Error(result.message || '获取视频信息失败')
    }
    return {
      title: result.data.title || '',
      author: result.data.owner?.name || '',
    }
  })
}
function registerGalleryHandlers() {
  ipcMain.handle('gallery:scanDirectory', async (_event, galleryRoot) => {
    const cleanPath = String(galleryRoot || '').trim()

    if (!cleanPath) {
      throw new Error('图片目录不能为空')
    }

    const stat = await fs.stat(cleanPath)

    if (!stat.isDirectory()) {
      throw new Error('选择的路径不是文件夹')
    }

    return collectGalleryImages(cleanPath)
  })

  ipcMain.handle('gallery:copyImage', async (_event, imagePath) => {
    const cleanPath = String(imagePath || '').trim()

    if (!cleanPath) {
      throw new Error('图片路径不能为空')
    }

    const image = nativeImage.createFromPath(cleanPath)

    if (image.isEmpty()) {
      throw new Error('复制失败，无法读取图片')
    }

    clipboard.writeImage(image)

    return { success: true }
  })

  ipcMain.handle('gallery:deleteImage', async (_event, imagePath) => {
    const cleanPath = String(imagePath || '').trim()

    if (!cleanPath) {
      throw new Error('图片路径不能为空')
    }

    await shell.trashItem(cleanPath)
    return { success: true }
  })

  ipcMain.handle('gallery:deleteImages', async (_event, imagePaths) => {
    const paths = Array.isArray(imagePaths) ? imagePaths.map((item) => String(item || '').trim()).filter(Boolean) : []

    await Promise.all(paths.map((targetPath) => shell.trashItem(targetPath)))
    return { success: true, count: paths.length }
  })

  ipcMain.handle('gallery:copyImagesToDirectory', async (_event, payload) => {
    const targetDirectory = String(payload?.targetDirectory || '').trim()
    const paths = Array.isArray(payload?.paths) ? payload.paths.map((item) => String(item || '').trim()).filter(Boolean) : []

    if (!targetDirectory) {
      throw new Error('目标目录不能为空')
    }

    await fs.mkdir(targetDirectory, { recursive: true })

    for (const sourcePath of paths) {
      await fs.copyFile(sourcePath, path.join(targetDirectory, path.basename(sourcePath)))
    }

    return { success: true, count: paths.length }
  })

  ipcMain.handle('gallery:moveImagesToDirectory', async (_event, payload) => {
    const targetDirectory = String(payload?.targetDirectory || '').trim()
    const paths = Array.isArray(payload?.paths) ? payload.paths.map((item) => String(item || '').trim()).filter(Boolean) : []

    if (!targetDirectory) {
      throw new Error('目标目录不能为空')
    }

    await fs.mkdir(targetDirectory, { recursive: true })

    for (const sourcePath of paths) {
      await fs.rename(sourcePath, path.join(targetDirectory, path.basename(sourcePath)))
    }

    return { success: true, count: paths.length }
  })

  ipcMain.handle('gallery:openPath', async (_event, galleryPath) => {
    const cleanPath = String(galleryPath || '').trim()

    if (!cleanPath) {
      throw new Error('图片目录不能为空')
    }

    const errorMessage = await shell.openPath(cleanPath)

    if (errorMessage) {
      throw new Error(errorMessage)
    }

    return { success: true }
  })

  ipcMain.handle('gallery:revealItem', async (_event, itemPath) => {
    const cleanPath = String(itemPath || '').trim()

    if (!cleanPath) {
      throw new Error('图片路径不能为空')
    }

    shell.showItemInFolder(cleanPath)
    return { success: true }
  })

  ipcMain.handle('gallery:readPrompt', async (_event, imagePath) => {
    const cleanPath = String(imagePath || '').trim()

    if (!cleanPath) {
      throw new Error('图片路径不能为空')
    }

    const prompt = await readPromptFromImage(cleanPath)
    return { prompt }
  })

  ipcMain.handle('gallery:readImage', async (_event, imagePath) => {
    const cleanPath = String(imagePath || '').trim()

    if (!cleanPath) {
      throw new Error('图片路径不能为空')
    }

    const imageUrl = await createImageDataUrl(cleanPath)
    return { imageUrl }
  })

  ipcMain.handle('gallery:importImages', async (_event, payload) => {
    const targetDirectory = String(payload?.targetDirectory || '').trim()
    const paths = Array.isArray(payload?.paths) ? payload.paths.map((item) => String(item || '').trim()).filter(Boolean) : []

    if (!targetDirectory) {
      throw new Error('图片目录不能为空')
    }

    await fs.mkdir(targetDirectory, { recursive: true })

    const duplicateNames = []
    let importedCount = 0

    for (const sourcePath of paths) {
      const fileName = path.basename(sourcePath)
      const targetPath = path.join(targetDirectory, fileName)

      try {
        await fs.access(targetPath)
        duplicateNames.push(fileName)
        continue
      } catch {
        await fs.copyFile(sourcePath, targetPath)
        importedCount += 1
      }
    }

    return { success: true, importedCount, duplicateNames }
  })
}

function registerFeedbackHandlers() {
  ipcMain.handle('feedback:submit', async (_event, payload) => {
    const content = String(payload?.content || '').trim()

    if (!content) {
      throw new Error('反馈内容不能为空')
    }

    const message = [
      '【AI绘画资源管理 - 用户反馈】',
      `时间：${new Date().toLocaleString('zh-CN')}`,
      '反馈内容：',
      content,
    ].join('\n')

    const response = await fetch(FEEDBACK_WEBHOOK_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        msgtype: 'text',
        text: {
          content: message,
        },
      }),
    })

    if (!response.ok) {
      throw new Error(`反馈发送失败：HTTP ${response.status}`)
    }

    const result = await response.json()

    if (result?.errcode && result.errcode !== 0) {
      throw new Error(result.errmsg || '反馈发送失败')
    }

    return { success: true }
  })
}

function registerDialogHandlers() {
  ipcMain.handle('dialog:confirm', async (_event, payload) => {
    const result = await dialog.showMessageBox({
      type: 'question',
      title: payload?.title?.trim() || '通知',
      message: payload?.message?.trim() || '请确认当前操作',
      detail: payload?.detail?.trim() || '',
      buttons: [payload?.confirmText?.trim() || '确定', payload?.cancelText?.trim() || '取消'],
      defaultId: 0,
      cancelId: 1,
      noLink: true,
    })

    return { confirmed: result.response === 0 }
  })

  ipcMain.handle('dialog:alert', async (_event, payload) => {
    await dialog.showMessageBox({
      type: 'info',
      title: payload?.title?.trim() || '通知',
      message: payload?.message?.trim() || '操作已完成',
      detail: payload?.detail?.trim() || '',
      buttons: [payload?.buttonText?.trim() || '确定'],
      defaultId: 0,
      noLink: true,
    })

    return { acknowledged: true }
  })
}

function createWindow() {
  const { width: screenWidth, height: screenHeight } = screen.getPrimaryDisplay().workAreaSize

  const mainWindow = new BrowserWindow({
    width: Math.round(screenWidth * 0.8),
    height: Math.round(screenHeight * 0.8),
    minWidth: 1100,
    minHeight: 720,
    center: true,
    title: 'AI绘画教程资源管理',
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  })
  mainWindow.setTitle('AI绘画教程资源管理 V1.0.0')
  mainWindow.setIcon(nativeImage.createFromPath(path.join(app.getAppPath(), 'public', 'logo.png')))
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url)
    return { action: 'deny' }
  })
  mainWindow.webContents.on('will-navigate', (event, url) => {
    const currentUrl = mainWindow.webContents.getURL()
    if (url !== currentUrl && /^https?:\/\//.test(url)) {
      event.preventDefault()
      shell.openExternal(url)
    }
  })

  if (isDev) {
    mainWindow.loadURL('http://localhost:5173')
  } else {
    mainWindow.loadFile(path.join(__dirname, '../dist/index.html'))
  }
}

app.whenReady().then(() => {
  registerModelIpcHandlers()
  registerResourceStorageHandlers()
  registerBilibiliHandlers()
  registerGalleryHandlers()
  registerFeedbackHandlers()
  registerDialogHandlers()
  Menu.setApplicationMenu(null)
  createWindow()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow()
    }
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit()
  }
})


