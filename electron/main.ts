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

const getLinkedNode = (graph: Record<string, any>, link: unknown) => {
  if (!Array.isArray(link)) {
    return null
  }

  const linkedId = String(link[0] ?? '')
  return graph[linkedId] || null
}

const getLinkedNodeId = (link: unknown) => {
  if (!Array.isArray(link)) {
    return ''
  }

  return String(link[0] ?? '')
}

const getNodeTextInput = (node: any) => {
  const text = node?.inputs?.text
  return typeof text === 'string' ? text.trim() : ''
}

const readLinkedNodeIds = (node: any) => {
  const ids: string[] = []

  for (const input of Object.values(node?.inputs || {})) {
    if (Array.isArray(input)) {
      const nodeId = getLinkedNodeId(input)
      if (nodeId) {
        ids.push(nodeId)
      }
    }
  }

  return ids
}

const collectUpstreamNodeIds = (graph: Record<string, any>, link: unknown, visited = new Set<string>()) => {
  const nodeId = getLinkedNodeId(link)

  if (!nodeId || visited.has(nodeId)) {
    return visited
  }

  visited.add(nodeId)

  const node = graph[nodeId]
  for (const linkedId of readLinkedNodeIds(node)) {
    collectUpstreamNodeIds(graph, [linkedId, 0], visited)
  }

  return visited
}

const getOutputImageLinks = (graph: Record<string, any>) => {
  const links: unknown[] = []

  for (const node of Object.values(graph)) {
    const classType = String((node as any)?.class_type || '').toLowerCase()
    const imageLink = (node as any)?.inputs?.images

    if (['saveimage', 'previewimage'].includes(classType) && Array.isArray(imageLink)) {
      links.push(imageLink)
    }
  }

  return links
}

const findTextUpstream = (graph: Record<string, any>, link: unknown, visited = new Set<string>()): string => {
  const nodeId = getLinkedNodeId(link)

  if (!nodeId || visited.has(nodeId)) {
    return ''
  }

  visited.add(nodeId)

  const node = graph[nodeId]
  const text = getNodeTextInput(node)

  if (text) {
    return text
  }

  for (const input of Object.values(node?.inputs || {})) {
    if (Array.isArray(input)) {
      const upstreamText = findTextUpstream(graph, input, visited)

      if (upstreamText) {
        return upstreamText
      }
    }
  }

  return ''
}

const findSamplerUpstream = (graph: Record<string, any>, link: unknown, visited = new Set<string>()): any => {
  const nodeId = getLinkedNodeId(link)

  if (!nodeId || visited.has(nodeId)) {
    return null
  }

  visited.add(nodeId)

  const node = graph[nodeId]
  const classType = String(node?.class_type || '').toLowerCase()

  if (classType.includes('ksampler') || classType.includes('samplercustom')) {
    return node
  }

  for (const input of Object.values(node?.inputs || {})) {
    if (Array.isArray(input)) {
      const sampler = findSamplerUpstream(graph, input, visited)

      if (sampler) {
        return sampler
      }
    }
  }

  return null
}

const extractComfyPositivePrompt = (graph: Record<string, any>) => {
  const nodes = Object.values(graph)
  const outputNode = nodes.find((node: any) => {
    const classType = String(node?.class_type || '').toLowerCase()
    return ['saveimage', 'previewimage'].includes(classType) && Array.isArray(node?.inputs?.images)
  }) as any
  const samplerFromOutput = findSamplerUpstream(graph, outputNode?.inputs?.images)
  const sampler = samplerFromOutput || (nodes.find((node: any) => {
    const classType = String(node?.class_type || '').toLowerCase()
    return classType.includes('ksampler') && Array.isArray(node?.inputs?.positive)
  }) as any)

  const positiveText = findTextUpstream(graph, sampler?.inputs?.positive)

  if (positiveText) {
    return positiveText
  }

  const clipTextNode = nodes.find((node: any) => {
    const classType = String(node?.class_type || '').toLowerCase()
    return classType.includes('cliptextencode') && getNodeTextInput(node)
  }) as any

  return getNodeTextInput(clipTextNode)
}

const extractDirectTextInput = (content: string) => {
  const directTextMatch = content.match(/"inputs"\s*:\s*\{[\s\S]*?"text"\s*:\s*"([\s\S]*?)"\s*(?:,|\})/)

  if (!directTextMatch?.[1]) {
    return ''
  }

  try {
    return JSON.parse(`"${directTextMatch[1]}"`).trim()
  } catch {
    return directTextMatch[1].trim()
  }
}

const extractImageMetadata = async (imagePath: string) => {
  if (path.extname(imagePath).toLowerCase() !== '.png') {
    return {} as Record<string, string>
  }

  const buffer = await fs.readFile(imagePath)
  return extractPngTextChunks(buffer).reduce<Record<string, string>>((metadata, entry) => {
    metadata[entry.keyword] = entry.value
    return metadata
  }, {})
}

const parseMetadataGraph = (metadata: Record<string, string>) => {
  for (const key of ['prompt', 'workflow']) {
    try {
      const parsed = JSON.parse(metadata[key] || '')

      if (parsed && typeof parsed === 'object') {
        return parsed as Record<string, any>
      }
    } catch {
      // Continue with the next metadata field.
    }
  }

  return null
}

const addUniqueLora = (
  loras: Array<{ name: string; strengthModel?: number | string; strengthClip?: number | string }>,
  nextLora: { name: string; strengthModel?: number | string; strengthClip?: number | string },
) => {
  if (!nextLora.name) {
    return
  }

  const key = [nextLora.name, nextLora.strengthModel ?? '', nextLora.strengthClip ?? ''].join('|')
  const hasSameLora = loras.some((lora) => [lora.name, lora.strengthModel ?? '', lora.strengthClip ?? ''].join('|') === key)

  if (!hasSameLora) {
    loras.push(nextLora)
  }
}

const extractGenerationInfoFromGraph = (graph: Record<string, any>) => {
  const outputLinks = getOutputImageLinks(graph)
  const upstreamIds = new Set<string>()

  if (outputLinks.length > 0) {
    for (const link of outputLinks) {
      collectUpstreamNodeIds(graph, link, upstreamIds)
    }
  } else {
    for (const id of Object.keys(graph)) {
      upstreamIds.add(id)
    }
  }

  const info: {
    model?: string
    clip?: string
    vae?: string
    loras: Array<{ name: string; strengthModel?: number | string; strengthClip?: number | string }>
    params?: {
      seed?: number | string
      steps?: number | string
      cfg?: number | string
      sampler?: string
      scheduler?: string
      denoise?: number | string
    }
  } = {
    loras: [],
  }

  for (const id of upstreamIds) {
    const node = graph[id]
    const classType = String(node?.class_type || '').toLowerCase()
    const inputs = node?.inputs || {}

    if (!info.model) {
      info.model =
        inputs.ckpt_name ||
        inputs.unet_name ||
        inputs.model_name ||
        inputs.checkpoint ||
        inputs.diffusion_model_name ||
        info.model
    }

    if (!info.clip) {
      info.clip = inputs.clip_name || inputs.text_encoder_name || info.clip
    }

    if (!info.vae) {
      info.vae = inputs.vae_name || info.vae
    }

    if (classType.includes('lora') || inputs.lora_name) {
      addUniqueLora(info.loras, {
        name: String(inputs.lora_name || inputs.name || inputs.lora || ''),
        strengthModel: inputs.strength_model ?? inputs.model_strength ?? inputs.strength,
        strengthClip: inputs.strength_clip ?? inputs.clip_strength,
      })
    }

    if (!info.params && (classType.includes('ksampler') || classType.includes('samplercustom'))) {
      info.params = {
        seed: inputs.seed,
        steps: inputs.steps,
        cfg: inputs.cfg,
        sampler: inputs.sampler_name || inputs.sampler,
        scheduler: inputs.scheduler,
        denoise: inputs.denoise,
      }
    }
  }

  return info
}

const readGenerationInfoFromImage = async (imagePath: string) => {
  try {
    const metadata = await extractImageMetadata(imagePath)
    const graph = parseMetadataGraph(metadata)

    if (!graph) {
      return { loras: [] }
    }

    return extractGenerationInfoFromGraph(graph)
  } catch {
    return { loras: [] }
  }
}

const normalizePromptText = (content: unknown) => {
  if (!content) {
    return ''
  }

  const cleanContent = String(content).trim()

  if (!cleanContent) {
    return ''
  }

  try {
    const parsed = JSON.parse(cleanContent)
    const comfyPositivePrompt =
      parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? extractComfyPositivePrompt(parsed) : ''

    if (comfyPositivePrompt) {
      return comfyPositivePrompt
    }

    const extractedPrompt =
      parsed?.inputs?.text ||
      parsed?.text ||
      parsed?.prompt ||
      parsed?.parameters?.inputs?.text ||
      parsed?.node?.inputs?.text

    if (typeof extractedPrompt === 'string' && extractedPrompt.trim()) {
      return extractedPrompt.trim()
    }

    const nestedPrompt =
      parsed?.prompt && typeof parsed.prompt === 'object' ? normalizePromptText(JSON.stringify(parsed.prompt)) : ''
    if (nestedPrompt) {
      return nestedPrompt
    }

    const nestedWorkflow =
      parsed?.workflow && typeof parsed.workflow === 'object' ? normalizePromptText(JSON.stringify(parsed.workflow)) : ''
    if (nestedWorkflow) {
      return nestedWorkflow
    }

    const directText = extractDirectTextInput(cleanContent)
    if (directText) {
      return directText
    }

    return ''
  } catch {
    const directText = extractDirectTextInput(cleanContent)

    if (directText) {
      return directText
    }

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

function getBilibiliVideoQuery(input: string) {
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
  ipcMain.handle('bilibili:fetchInfo', async (_event, payload: { url?: string }) => {
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
    const result = (await response.json()) as {
      code?: number
      message?: string
      data?: {
        title?: string
        owner?: {
          name?: string
        }
      }
    }
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

  ipcMain.handle('gallery:readGenerationInfo', async (_event, imagePath: string) => {
    const cleanPath = String(imagePath || '').trim()

    if (!cleanPath) {
      throw new Error('图片路径不能为空')
    }

    const generationInfo = await readGenerationInfoFromImage(cleanPath)
    return { generationInfo }
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
  registerBilibiliHandlers()
  registerGalleryHandlers()
  registerFeedbackHandlers()
  registerDialogHandlers()
  Menu.setApplicationMenu(null)
  createWindow()
})

