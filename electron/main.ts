import { app, BrowserWindow, clipboard, dialog, ipcMain, Menu, nativeImage, screen, shell } from 'electron'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import fs from 'node:fs/promises'
import { createHash } from 'node:crypto'

const require = createRequire(import.meta.url)
const __dirname = path.dirname(fileURLToPath(import.meta.url))

type ResourceNode = {
  id: string
  name: string
  path: string
  type: 'folder' | 'file'
  size?: number
  modifiedAt?: string
  children?: ResourceNode[]
}

const IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.webp', '.bmp', '.gif'])
const FEEDBACK_WEBHOOK_URL =
  'https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=bd0a28ce-4372-4c03-b376-bc180611b40d'

process.env.APP_ROOT = path.join(__dirname, '..')

export const VITE_DEV_SERVER_URL = process.env['VITE_DEV_SERVER_URL']
export const MAIN_DIST = path.join(process.env.APP_ROOT, 'dist-electron')
export const RENDERER_DIST = path.join(process.env.APP_ROOT, 'dist')

process.env.VITE_PUBLIC = VITE_DEV_SERVER_URL ? path.join(process.env.APP_ROOT, 'public') : RENDERER_DIST

let win: BrowserWindow | null

function getDataDirectory() {
  if (app.isPackaged) {
    return path.join(path.dirname(app.getPath('exe')), 'data')
  }

  return path.join(app.getAppPath(), 'data')
}

function getResourcesFilePath() {
  return path.join(getDataDirectory(), 'resources.json')
}

async function ensureDataDirectory() {
  await fs.mkdir(getDataDirectory(), { recursive: true })
}

function getCacheDirectory() {
  if (app.isPackaged) {
    return path.join(path.dirname(app.getPath('exe')), 'cache')
  }

  return path.join(app.getAppPath(), 'cache')
}

async function ensureCacheDirectory() {
  await fs.mkdir(getCacheDirectory(), { recursive: true })
}

const scanDirectoryTree = async (directoryPath: string): Promise<ResourceNode> => {
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
  const children: ResourceNode[] = []

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

const isImageFile = (filePath: string) => IMAGE_EXTENSIONS.has(path.extname(filePath).toLowerCase())

const normalizePromptText = (content: unknown) => {
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

const getMimeType = (filePath: string) => {
  const extension = path.extname(filePath).toLowerCase()

  if (extension === '.png') return 'image/png'
  if (extension === '.jpg' || extension === '.jpeg') return 'image/jpeg'
  if (extension === '.webp') return 'image/webp'
  if (extension === '.gif') return 'image/gif'
  if (extension === '.bmp') return 'image/bmp'

  return 'application/octet-stream'
}

const createImageDataUrl = async (filePath: string) => {
  const buffer = await fs.readFile(filePath)
  return `data:${getMimeType(filePath)};base64,${buffer.toString('base64')}`
}

const createThumbnailDataUrl = async (filePath: string) => {
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

const extractPngTextChunks = (buffer: Buffer) => {
  if (!buffer || buffer.length < 8 || buffer.subarray(0, 8).toString('hex') !== '89504e470d0a1a0a') {
    return [] as Array<{ keyword: string; value: string }>
  }

  const entries: Array<{ keyword: string; value: string }> = []
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
        entries.push({
          keyword: buffer.toString('utf8', dataStart, nullIndex),
          value: buffer.toString('utf8', nullIndex + 1, dataEnd),
        })
      }
    }

    if (chunkType === 'IEND') {
      break
    }

    offset = dataEnd + 4
  }

  return entries
}

const readPromptFromImage = async (imagePath: string) => {
  try {
    if (path.extname(imagePath).toLowerCase() === '.png') {
      const buffer = await fs.readFile(imagePath)
      const entries = extractPngTextChunks(buffer)
      const preferredEntry = entries.find((entry) =>
        ['prompt', 'parameters', 'workflow'].includes(entry.keyword.toLowerCase()),
      )

      if (preferredEntry?.value) {
        return normalizePromptText(preferredEntry.value)
      }

      if (entries.length > 0) {
        return normalizePromptText(entries.map((entry) => `${entry.keyword}: ${entry.value}`).join('\n\n'))
      }
    }

    return normalizePromptText(await fs.readFile(`${imagePath}.txt`, 'utf-8'))
  } catch {
    return ''
  }
}

const collectGalleryImages = async (directoryPath: string) => {
  const entries = await fs.readdir(directoryPath, { withFileTypes: true })
  const items: any[] = []

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

  ipcMain.handle('models:scanDirectory', async (_event, modelsRoot: string) => {
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

function registerGalleryHandlers() {
  ipcMain.handle('gallery:scanDirectory', async (_event, galleryRoot: string) => {
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

  ipcMain.handle('gallery:copyImage', async (_event, imagePath: string) => {
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

  ipcMain.handle('gallery:deleteImage', async (_event, imagePath: string) => {
    const cleanPath = String(imagePath || '').trim()

    if (!cleanPath) {
      throw new Error('图片路径不能为空')
    }

    await shell.trashItem(cleanPath)
    return { success: true }
  })

  ipcMain.handle('gallery:deleteImages', async (_event, imagePaths: string[]) => {
    const paths = Array.isArray(imagePaths) ? imagePaths.map((item) => String(item || '').trim()).filter(Boolean) : []

    await Promise.all(paths.map((targetPath) => shell.trashItem(targetPath)))
    return { success: true, count: paths.length }
  })

  ipcMain.handle('gallery:copyImagesToDirectory', async (_event, payload: { targetDirectory?: string; paths?: string[] }) => {
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

  ipcMain.handle('gallery:moveImagesToDirectory', async (_event, payload: { targetDirectory?: string; paths?: string[] }) => {
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

  ipcMain.handle('gallery:openPath', async (_event, galleryPath: string) => {
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

  ipcMain.handle('gallery:revealItem', async (_event, itemPath: string) => {
    const cleanPath = String(itemPath || '').trim()

    if (!cleanPath) {
      throw new Error('图片路径不能为空')
    }

    shell.showItemInFolder(cleanPath)
    return { success: true }
  })

  ipcMain.handle('gallery:readPrompt', async (_event, imagePath: string) => {
    const cleanPath = String(imagePath || '').trim()

    if (!cleanPath) {
      throw new Error('图片路径不能为空')
    }

    const prompt = await readPromptFromImage(cleanPath)
    return { prompt }
  })

  ipcMain.handle('gallery:readImage', async (_event, imagePath: string) => {
    const cleanPath = String(imagePath || '').trim()

    if (!cleanPath) {
      throw new Error('图片路径不能为空')
    }

    const imageUrl = await createImageDataUrl(cleanPath)
    return { imageUrl }
  })

  ipcMain.handle(
    'gallery:importImages',
    async (_event, payload: { targetDirectory?: string; paths?: string[] }) => {
      const targetDirectory = String(payload?.targetDirectory || '').trim()
      const paths = Array.isArray(payload?.paths)
        ? payload.paths.map((item) => String(item || '').trim()).filter(Boolean)
        : []

      if (!targetDirectory) {
        throw new Error('图片目录不能为空')
      }

      await fs.mkdir(targetDirectory, { recursive: true })

      const duplicateNames: string[] = []
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
    },
  )
}

function registerFeedbackHandlers() {
  ipcMain.handle('feedback:submit', async (_event, payload: { content?: string; page?: string }) => {
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

    const result = (await response.json()) as { errcode?: number; errmsg?: string }

    if (result?.errcode && result.errcode !== 0) {
      throw new Error(result.errmsg || '反馈发送失败')
    }

    return { success: true }
  })
}

function registerDialogHandlers() {
  ipcMain.handle(
    'dialog:confirm',
    async (
      _event,
      payload: {
        title?: string
        message?: string
        detail?: string
        confirmText?: string
        cancelText?: string
      },
    ) => {
      const result = await dialog.showMessageBox(win ?? undefined, {
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
    },
  )

  ipcMain.handle(
    'dialog:alert',
    async (
      _event,
      payload: {
        title?: string
        message?: string
        detail?: string
        buttonText?: string
      },
    ) => {
      await dialog.showMessageBox(win ?? undefined, {
        type: 'info',
        title: payload?.title?.trim() || '通知',
        message: payload?.message?.trim() || '操作已完成',
        detail: payload?.detail?.trim() || '',
        buttons: [payload?.buttonText?.trim() || '确定'],
        defaultId: 0,
        noLink: true,
      })

      return { acknowledged: true }
    },
  )
}

function createWindow() {
  const { width: screenWidth, height: screenHeight } = screen.getPrimaryDisplay().workAreaSize

  win = new BrowserWindow({
    width: Math.round(screenWidth * 0.8),
    height: Math.round(screenHeight * 0.8),
    minWidth: 1100,
    minHeight: 720,
    center: true,
    title: 'AI绘画教程资源管理',
    icon: path.join(process.env.VITE_PUBLIC, 'logo.png'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.mjs'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  })
  win.setTitle('AI绘画教程资源管理 V1.0.0')
  win.setIcon(nativeImage.createFromPath(path.join(process.env.VITE_PUBLIC, 'logo.png')))
  win.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url)
    return { action: 'deny' }
  })
  win.webContents.on('will-navigate', (event, url) => {
    const currentUrl = win?.webContents.getURL()
    if (url !== currentUrl && /^https?:\/\//.test(url)) {
      event.preventDefault()
      shell.openExternal(url)
    }
  })

  win.webContents.on('did-finish-load', () => {
    win?.webContents.send('main-process-message', new Date().toLocaleString())
  })

  if (VITE_DEV_SERVER_URL) {
    win.loadURL(VITE_DEV_SERVER_URL)
  } else {
    win.loadFile(path.join(RENDERER_DIST, 'index.html'))
  }
}

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit()
    win = null
  }
})

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    createWindow()
  }
})

app.whenReady().then(() => {
  registerModelIpcHandlers()
  registerResourceStorageHandlers()
  registerGalleryHandlers()
  registerFeedbackHandlers()
  registerDialogHandlers()
  Menu.setApplicationMenu(null)
  createWindow()
})
