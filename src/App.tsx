import { useEffect, useMemo, useRef, useState } from 'react'
import type { CSSProperties, DragEvent } from 'react'
import './App.css'

type ResourceNode = {
  id: string
  name: string
  path: string
  type: 'folder' | 'file'
  size?: number
  modifiedAt?: string
  children?: ResourceNode[]
}

type ScannedResourceItem = {
  name: string
  path: string
  type: 'folder' | 'file'
  size?: number
  modifiedAt?: string
}

type Tutorial = {
  id: string
  title: string
  author: string
  url: string
  topicId: string
  tags: string[]
  resourcePath: string
  resources: ResourceNode[]
}

type Topic = {
  id: string
  name: string
  description: string
}

type GalleryImage = {
  id: string
  type: 'folder' | 'file'
  name: string
  path: string
  imageUrl?: string
  thumbnailUrl?: string
  prompt?: string
  size?: number
  modifiedAt?: string
  modifiedTimestamp?: number
}

type PersistedAppData = {
  tutorials?: Tutorial[]
  topics?: Topic[]
  galleryPath?: string
}
type BilibiliVideoInfo = {
  title: string
  author: string
}

type DesktopResourceApi = {
  selectDirectory?: () => Promise<string | null>
  scanDirectory?: (path: string) => Promise<ResourceNode[] | ScannedResourceItem[]>
  load?: () => Promise<PersistedAppData | null>
  fetchBilibiliInfo?: (payload: { url: string }) => Promise<BilibiliVideoInfo>
  save?: (data: {
    tutorials: Tutorial[]
    topics: Topic[]
    galleryPath?: string
  }) => Promise<{ success: boolean; filePath?: string }>
  scanGalleryDirectory?: (path: string) => Promise<GalleryImage[]>
  copyImage?: (imagePath: string) => Promise<{ success: boolean }>
  deleteImage?: (imagePath: string) => Promise<{ success: boolean }>
  deleteImages?: (imagePaths: string[]) => Promise<{ success: boolean; count?: number }>
  copyImagesToDirectory?: (payload: {
    targetDirectory?: string
    paths?: string[]
  }) => Promise<{ success: boolean; count?: number }>
  moveImagesToDirectory?: (payload: {
    targetDirectory?: string
    paths?: string[]
  }) => Promise<{ success: boolean; count?: number }>
  openGalleryPath?: (path: string) => Promise<{ success: boolean }>
  revealGalleryItem?: (path: string) => Promise<{ success: boolean }>
  importGalleryImages?: (payload: {
    targetDirectory?: string
    paths?: string[]
  }) => Promise<{ success: boolean; importedCount?: number; duplicateNames?: string[] }>
  readGalleryPrompt?: (path: string) => Promise<{ prompt: string }>
  readGalleryImage?: (path: string) => Promise<{ imageUrl: string }>
  submitFeedback?: (payload: { content?: string; page?: string }) => Promise<{ success: boolean }>
  showConfirmDialog?: (payload: {
    title?: string
    message?: string
    detail?: string
    confirmText?: string
    cancelText?: string
  }) => Promise<{ confirmed: boolean }>
  showAlertDialog?: (payload: {
    title?: string
    message?: string
    detail?: string
    buttonText?: string
  }) => Promise<{ acknowledged: boolean }>
}

declare global {
  interface Window {
    localModels?: DesktopResourceApi
    resourceApi?: DesktopResourceApi
    electronAPI?: DesktopResourceApi
    __TAURI__?: {
      core?: {
        invoke?: <T>(command: string, args?: Record<string, unknown>) => Promise<T>
      }
      tauri?: {
        invoke?: <T>(command: string, args?: Record<string, unknown>) => Promise<T>
      }
    }
  }
}

const replaceDisplayBrandText = (value: string) => value.replace(/ComfyUI/gi, 'AI绘画')

const runWithDialogTitle = <T,>(title: string, action: () => T) => {
  const previousTitle = document.title
  document.title = title

  try {
    return action()
  } finally {
    document.title = previousTitle
  }
}

const showNoticeAlert = (message: string) => runWithDialogTitle('通知', () => window.alert(message))

const showNoticeConfirm = (message: string) => runWithDialogTitle('通知', () => window.confirm(message))

const defaultTopics: Topic[] = [{ id: 'basics', name: '文生图', description: 'Z-image' }]
const TOPIC_NAME_MAX_LENGTH = 12
const COMPARE_DEFAULT_ZOOM = 1
const isLikelyUrl = (value: string) => /^(https?:\/\/|www\.)/i.test(value.trim())

const getBilibiliVideoKey = (input: string) => {
  const cleanInput = input.trim()
  const bvMatch = cleanInput.match(/BV[a-zA-Z0-9]+/)

  if (bvMatch) {
    return bvMatch[0].toUpperCase()
  }

  const avMatch = cleanInput.match(/av(\d+)/i)

  if (avMatch?.[1]) {
    return `AV${avMatch[1]}`
  }

  return ''
}

const isSupportedImagePath = (path: string) => /\.(png|jpe?g|webp|bmp|gif)$/i.test(path)

const initialTutorials: Tutorial[] = []

const createEmptyResources = (): ResourceNode[] => []

const normalizePath = (path: string) => path.replace(/\\/g, '/')

const getPathName = (path: string) => {
  const parts = normalizePath(path).split('/').filter(Boolean)
  return parts.at(-1) || path
}

const removeRootFromPath = (path: string, rootPath: string) => {
  const normalizedPath = normalizePath(path)
  const normalizedRoot = normalizePath(rootPath).replace(/\/$/, '')

  if (!normalizedRoot || normalizedPath === normalizedRoot) {
    return path
  }

  if (normalizedPath.startsWith(`${normalizedRoot}/`)) {
    return normalizedPath.slice(normalizedRoot.length + 1)
  }

  return normalizedPath.replace(/^[a-zA-Z]:\//, '')
}

const formatFileSize = (size?: number) => {
  if (!size) {
    return '未知大小'
  }

  if (size < 1024) {
    return `${size} B`
  }

  if (size < 1024 * 1024) {
    return `${(size / 1024).toFixed(1)} KB`
  }

  if (size < 1024 * 1024 * 1024) {
    return `${(size / 1024 / 1024).toFixed(1)} MB`
  }

  return `${(size / 1024 / 1024 / 1024).toFixed(1)} GB`
}

const countResourceFiles = (nodes: ResourceNode[]): number => {
  return nodes.reduce((total, node) => {
    if (node.type === 'file') {
      return total + 1
    }

    return total + countResourceFiles(node.children || [])
  }, 0)
}

const countResourceChildren = (node: ResourceNode): number => {
  if (node.type === 'file') {
    return 1
  }

  return (node.children || []).reduce((total, child) => total + countResourceChildren(child), 0)
}

const sortResourceNodes = (nodes: ResourceNode[]) => {
  nodes.sort((first, second) => {
    if (first.type !== second.type) {
      return first.type === 'folder' ? -1 : 1
    }

    return first.name.localeCompare(second.name, 'zh-CN')
  })

  nodes.forEach((node) => {
    if (node.children) {
      sortResourceNodes(node.children)
    }
  })

  return nodes
}

const addPathToTree = (
  nodes: ResourceNode[],
  pathParts: string[],
  sourcePath: string,
  item: ScannedResourceItem,
  currentPath = '',
) => {
  const [currentPart, ...remainingParts] = pathParts

  if (!currentPart) {
    return
  }

  const nextPath = currentPath ? `${currentPath}/${currentPart}` : currentPart
  const isFile = remainingParts.length === 0 && item.type === 'file'

  if (isFile) {
    nodes.push({
      id: sourcePath,
      name: currentPart,
      path: item.path,
      type: 'file',
      size: item.size,
      modifiedAt: item.modifiedAt,
    })
    return
  }

  let folder = nodes.find((node) => node.type === 'folder' && node.path === nextPath)

  if (!folder) {
    folder = {
      id: nextPath,
      name: currentPart,
      path: nextPath,
      type: 'folder',
      children: [],
    }

    nodes.push(folder)
  }

  if (remainingParts.length === 0) {
    return
  }

  addPathToTree(folder.children || [], remainingParts, sourcePath, item, nextPath)
}

const createResourceTreeFromScannedItems = (
  scanRootPath: string,
  items: ScannedResourceItem[],
): ResourceNode[] => {
  const rootNode: ResourceNode = {
    id: scanRootPath,
    name: getPathName(scanRootPath),
    path: scanRootPath,
    type: 'folder',
    children: [],
  }

  const normalizedRoot = normalizePath(scanRootPath).replace(/\/$/, '')

  items.forEach((item) => {
    const normalizedItemPath = normalizePath(item.path)
    const relativePath = normalizedItemPath.startsWith(normalizedRoot)
      ? normalizedItemPath.slice(normalizedRoot.length).replace(/^\//, '')
      : normalizedItemPath

    const pathParts = relativePath.split('/').filter(Boolean)

    if (pathParts.length === 0) {
      return
    }

    addPathToTree(rootNode.children || [], pathParts, item.path, item)
  })

  rootNode.children = sortResourceNodes(rootNode.children || [])
  return [rootNode]
}

const normalizeScannedTree = (scanRootPath: string, nodes: ResourceNode[]): ResourceNode[] => {
  const normalizedRoot = normalizePath(scanRootPath).replace(/\/$/, '')

  if (nodes.length === 0) {
    return [
      {
        id: scanRootPath,
        name: getPathName(scanRootPath),
        path: scanRootPath,
        type: 'folder',
        children: [],
      },
    ]
  }

  const hasRootNode = nodes.some((node) => normalizePath(node.path).replace(/\/$/, '') === normalizedRoot)

  if (hasRootNode) {
    return sortResourceNodes(nodes)
  }

  return [
    {
      id: scanRootPath,
      name: getPathName(scanRootPath),
      path: scanRootPath,
      type: 'folder',
      children: sortResourceNodes(nodes),
    },
  ]
}

const isResourceNodeArray = (
  items: ResourceNode[] | ScannedResourceItem[],
): items is ResourceNode[] => items.every((item) => 'children' in item || item.type === 'file')

const getResourceFileIcon = (fileName: string) => {
  const ext = fileName.includes('.') ? fileName.slice(fileName.lastIndexOf('.')).toLowerCase() : ''

  if (['.zip', '.rar', '.7z', '.tar', '.gz'].includes(ext)) {
    return '🗜️'
  }

  if (['.json', '.yaml', '.yml', '.toml', '.ini', '.txt', '.md'].includes(ext)) {
    return '📝'
  }

  if (['.doc', '.docx', '.pdf'].includes(ext)) {
    return '📘'
  }

  if (['.xls', '.xlsx', '.csv'].includes(ext)) {
    return '📊'
  }

  if (['.png', '.jpg', '.jpeg', '.webp', '.bmp', '.gif'].includes(ext)) {
    return '🖼️'
  }

  if (['.mp4', '.mov', '.avi', '.mkv', '.webm'].includes(ext)) {
    return '🎬'
  }

  if (['.mp3', '.wav', '.flac', '.aac', '.ogg'].includes(ext)) {
    return '🎵'
  }

  if (['.safetensors', '.ckpt', '.pt', '.pth', '.bin'].includes(ext)) {
    return '🧠'
  }

  return '📄'
}

const selectDirectoryByDesktopApi = async () => {
  if (window.localModels?.selectDirectory) {
    return window.localModels.selectDirectory()
  }
  if (window.resourceApi?.selectDirectory) {
    return window.resourceApi.selectDirectory()
  }
  if (window.electronAPI?.selectDirectory) {
    return window.electronAPI.selectDirectory()
  }
  const tauriInvoke = window.__TAURI__?.core?.invoke || window.__TAURI__?.tauri?.invoke
  if (tauriInvoke) {
    return tauriInvoke<string | null>('select_directory')
  }
  throw new Error('当前桌面端没有暴露选择目录接口')
}

const loadResourcesByDesktopApi = async () => {
  if (window.resourceApi?.load) {
    return window.resourceApi.load()
  }
  if (window.localModels?.load) {
    return window.localModels.load()
  }
  return null
}

const saveAppDataByDesktopApi = async (
  tutorials: Tutorial[],
  topics: Topic[],
  galleryPath: string,
) => {
  if (window.resourceApi?.save) {
    return window.resourceApi.save({ tutorials, topics, galleryPath })
  }
  if (window.localModels?.save) {
    return window.localModels.save({ tutorials, topics, galleryPath })
  }
  return null
}
const fetchBilibiliInfoByDesktopApi = async (url: string) => {
  if (window.resourceApi?.fetchBilibiliInfo) {
    return window.resourceApi.fetchBilibiliInfo({ url })
  }
  if (window.localModels?.fetchBilibiliInfo) {
    return window.localModels.fetchBilibiliInfo({ url })
  }
  if (window.electronAPI?.fetchBilibiliInfo) {
    return window.electronAPI.fetchBilibiliInfo({ url })
  }
  throw new Error('当前桌面端没有暴露 B 站信息获取接口')
}

const scanDirectoryByDesktopApi = async (path: string) => {
  if (window.localModels?.scanDirectory) {
    return window.localModels.scanDirectory(path)
  }

  if (window.resourceApi?.scanDirectory) {
    return window.resourceApi.scanDirectory(path)
  }

  if (window.electronAPI?.scanDirectory) {
    return window.electronAPI.scanDirectory(path)
  }

  const tauriInvoke = window.__TAURI__?.core?.invoke || window.__TAURI__?.tauri?.invoke

  if (tauriInvoke) {
    return tauriInvoke<ResourceNode[] | ScannedResourceItem[]>('scan_directory', { path })
  }

  throw new Error('当前桌面端没有暴露扫描目录接口')
}

const scanGalleryDirectoryByDesktopApi = async (path: string) => {
  if (window.resourceApi?.scanGalleryDirectory) {
    return window.resourceApi.scanGalleryDirectory(path)
  }
  if (window.localModels?.scanGalleryDirectory) {
    return window.localModels.scanGalleryDirectory(path)
  }
  if (window.electronAPI?.scanGalleryDirectory) {
    return window.electronAPI.scanGalleryDirectory(path)
  }
  throw new Error('当前桌面端没有暴露图库扫描接口')
}

const copyGalleryImageByDesktopApi = async (imagePath: string) => {
  if (window.resourceApi?.copyImage) {
    return window.resourceApi.copyImage(imagePath)
  }
  if (window.localModels?.copyImage) {
    return window.localModels.copyImage(imagePath)
  }
  if (window.electronAPI?.copyImage) {
    return window.electronAPI.copyImage(imagePath)
  }
  throw new Error('当前桌面端没有暴露复制图片接口')
}

const deleteGalleryImageByDesktopApi = async (imagePath: string) => {
  if (window.resourceApi?.deleteImage) {
    return window.resourceApi.deleteImage(imagePath)
  }
  if (window.localModels?.deleteImage) {
    return window.localModels.deleteImage(imagePath)
  }
  if (window.electronAPI?.deleteImage) {
    return window.electronAPI.deleteImage(imagePath)
  }
  throw new Error('当前桌面端没有暴露删除图片接口')
}

const deleteGalleryImagesByDesktopApi = async (imagePaths: string[]) => {
  if (window.resourceApi?.deleteImages) {
    return window.resourceApi.deleteImages(imagePaths)
  }
  if (window.localModels?.deleteImages) {
    return window.localModels.deleteImages(imagePaths)
  }
  if (window.electronAPI?.deleteImages) {
    return window.electronAPI.deleteImages(imagePaths)
  }
  throw new Error('当前桌面端没有暴露批量删除图片接口')
}

const copyGalleryImagesToDirectoryByDesktopApi = async (payload: {
  targetDirectory?: string
  paths?: string[]
}) => {
  if (window.resourceApi?.copyImagesToDirectory) {
    return window.resourceApi.copyImagesToDirectory(payload)
  }
  if (window.localModels?.copyImagesToDirectory) {
    return window.localModels.copyImagesToDirectory(payload)
  }
  if (window.electronAPI?.copyImagesToDirectory) {
    return window.electronAPI.copyImagesToDirectory(payload)
  }
  throw new Error('当前桌面端没有暴露批量复制图片接口')
}

const moveGalleryImagesToDirectoryByDesktopApi = async (payload: {
  targetDirectory?: string
  paths?: string[]
}) => {
  if (window.resourceApi?.moveImagesToDirectory) {
    return window.resourceApi.moveImagesToDirectory(payload)
  }
  if (window.localModels?.moveImagesToDirectory) {
    return window.localModels.moveImagesToDirectory(payload)
  }
  if (window.electronAPI?.moveImagesToDirectory) {
    return window.electronAPI.moveImagesToDirectory(payload)
  }
  throw new Error('当前桌面端没有暴露批量移动图片接口')
}

const openGalleryPathByDesktopApi = async (path: string) => {
  if (window.resourceApi?.openGalleryPath) {
    return window.resourceApi.openGalleryPath(path)
  }
  if (window.localModels?.openGalleryPath) {
    return window.localModels.openGalleryPath(path)
  }
  if (window.electronAPI?.openGalleryPath) {
    return window.electronAPI.openGalleryPath(path)
  }
  throw new Error('当前桌面端没有暴露打开文件夹接口')
}

const revealGalleryItemByDesktopApi = async (path: string) => {
  if (window.resourceApi?.revealGalleryItem) {
    return window.resourceApi.revealGalleryItem(path)
  }
  if (window.localModels?.revealGalleryItem) {
    return window.localModels.revealGalleryItem(path)
  }
  if (window.electronAPI?.revealGalleryItem) {
    return window.electronAPI.revealGalleryItem(path)
  }
  throw new Error('当前桌面端没有暴露定位文件接口')
}

const importGalleryImagesByDesktopApi = async (payload: {
  targetDirectory?: string
  paths?: string[]
}) => {
  if (window.resourceApi?.importGalleryImages) {
    return window.resourceApi.importGalleryImages(payload)
  }
  if (window.localModels?.importGalleryImages) {
    return window.localModels.importGalleryImages(payload)
  }
  if (window.electronAPI?.importGalleryImages) {
    return window.electronAPI.importGalleryImages(payload)
  }
  throw new Error('当前桌面端没有暴露图片导入接口')
}

const readGalleryPromptByDesktopApi = async (path: string) => {
  if (window.resourceApi?.readGalleryPrompt) {
    return window.resourceApi.readGalleryPrompt(path)
  }
  if (window.localModels?.readGalleryPrompt) {
    return window.localModels.readGalleryPrompt(path)
  }
  if (window.electronAPI?.readGalleryPrompt) {
    return window.electronAPI.readGalleryPrompt(path)
  }
  throw new Error('当前桌面端没有暴露提示词读取接口')
}

const readGalleryImageByDesktopApi = async (path: string) => {
  if (window.resourceApi?.readGalleryImage) {
    return window.resourceApi.readGalleryImage(path)
  }
  if (window.localModels?.readGalleryImage) {
    return window.localModels.readGalleryImage(path)
  }
  if (window.electronAPI?.readGalleryImage) {
    return window.electronAPI.readGalleryImage(path)
  }
  throw new Error('当前桌面端没有暴露图片读取接口')
}

const submitFeedbackByDesktopApi = async (payload: { content?: string; page?: string }) => {
  if (window.resourceApi?.submitFeedback) {
    return window.resourceApi.submitFeedback(payload)
  }
  if (window.localModels?.submitFeedback) {
    return window.localModels.submitFeedback(payload)
  }
  if (window.electronAPI?.submitFeedback) {
    return window.electronAPI.submitFeedback(payload)
  }
  throw new Error('当前桌面端没有暴露反馈提交接口')
}

const showConfirmDialogByDesktopApi = async (payload: {
  title?: string
  message?: string
  detail?: string
  confirmText?: string
  cancelText?: string
}) => {
  if (window.resourceApi?.showConfirmDialog) {
    return window.resourceApi.showConfirmDialog(payload)
  }
  if (window.localModels?.showConfirmDialog) {
    return window.localModels.showConfirmDialog(payload)
  }
  if (window.electronAPI?.showConfirmDialog) {
    return window.electronAPI.showConfirmDialog(payload)
  }

  return { confirmed: showNoticeConfirm(payload.message || payload.detail || '请确认当前操作') }
}

const showAlertDialogByDesktopApi = async (payload: {
  title?: string
  message?: string
  detail?: string
  buttonText?: string
}) => {
  if (window.resourceApi?.showAlertDialog) {
    return window.resourceApi.showAlertDialog(payload)
  }
  if (window.localModels?.showAlertDialog) {
    return window.localModels.showAlertDialog(payload)
  }
  if (window.electronAPI?.showAlertDialog) {
    return window.electronAPI.showAlertDialog(payload)
  }

  showNoticeAlert(payload.message || payload.detail || '操作已完成')
  return { acknowledged: true }
}

const ResourceTree = ({
  nodes,
  expandedIds,
  onToggle,
  rootPath,
  level = 0,
}: {
  nodes: ResourceNode[]
  expandedIds: string[]
  onToggle: (id: string) => void
  rootPath: string
  level?: number
}) => {
  if (nodes.length === 0) {
    return <div className="empty-resource-tree">暂无资源，点击上方按钮添加路径并扫描。</div>
  }

  return (
    <div className={level === 0 ? 'resource-tree' : 'resource-tree nested'}>
      {nodes.map((node, index) => {
        const isFolder = node.type === 'folder'
        const isExpanded = expandedIds.includes(node.id)
        const childCount = isFolder ? countResourceChildren(node) : 0
        const hasChildren = Boolean(node.children?.length)
        const isLast = index === nodes.length - 1
        const displayPath = level === 0 ? node.path : removeRootFromPath(node.path, rootPath)

        return (
          <div
            key={node.id}
            className={`resource-node level-${level} ${isLast ? 'last' : ''}`}
            style={{ '--tree-level': level } as CSSProperties}
          >
            <button
              type="button"
              className={`resource-node-row ${node.type} ${isExpanded ? 'expanded' : ''}`}
              onClick={(event) => {
                event.preventDefault()
                event.stopPropagation()

                if (isFolder && hasChildren) {
                  onToggle(node.id)
                }
              }}
            >
              <span className={`tree-branch ${isLast ? 'last' : ''}`}>└</span>
              <span className={`folder-chevron ${isExpanded ? 'expanded' : ''}`}>
                {isFolder && hasChildren ? '›' : ''}
              </span>
              <span className={`resource-icon ${isFolder ? 'folder' : 'file'}`}>
                {isFolder ? (isExpanded ? '📂' : '📁') : getResourceFileIcon(node.name)}
              </span>

              <div className="resource-node-main">
                <strong>{node.name}</strong>
                <small>{displayPath}</small>
              </div>

              {isFolder ? (
                <div className="resource-meta">
                  <span>{childCount} 项</span>
                  <span>{hasChildren ? (isExpanded ? '收起' : '展开') : '空目录'}</span>
                </div>
              ) : (
                <div className="resource-meta">
                  <span>{formatFileSize(node.size)}</span>
                  <span>{node.modifiedAt || '-'}</span>
                </div>
              )}
            </button>

            {isFolder && isExpanded && node.children && node.children.length > 0 && (
              <ResourceTree
                nodes={node.children}
                expandedIds={expandedIds}
                onToggle={onToggle}
                rootPath={rootPath}
                level={level + 1}
              />
            )}
          </div>
        )
      })}
    </div>
  )
}

function App() {
  const hasLoadedSavedData = useRef(false)
  const [themeMode, setThemeMode] = useState<'dark' | 'light'>('light')
  const [activeSidebarView, setActiveSidebarView] = useState<'tutorials' | 'gallery'>('tutorials')
  const [topics, setTopics] = useState<Topic[]>(defaultTopics)
  const [tutorials, setTutorials] = useState<Tutorial[]>(initialTutorials)
  const [selectedTopicId, setSelectedTopicId] = useState(defaultTopics[0].id)
  const [selectedTutorialId, setSelectedTutorialId] = useState<string | null>(initialTutorials[0]?.id || null)
  const [searchKeyword, setSearchKeyword] = useState('')

  const [showAddModal, setShowAddModal] = useState(false)
  const [url, setUrl] = useState('')
  const [title, setTitle] = useState('')
  const [author, setAuthor] = useState('')
  const [topicId, setTopicId] = useState(defaultTopics[0].id)
  const [tags, setTags] = useState('')
  const [isFetchingVideoInfo, setIsFetchingVideoInfo] = useState(false)
  const [videoInfoError, setVideoInfoError] = useState('')
  const [editingTutorialId, setEditingTutorialId] = useState<string | null>(null)

  const [showTopicModal, setShowTopicModal] = useState(false)
  const [editingTopicId, setEditingTopicId] = useState<string | null>(null)
  const [openTopicMenuId, setOpenTopicMenuId] = useState<string | null>(null)
  const [openTutorialMenuId, setOpenTutorialMenuId] = useState<string | null>(null)
  const [topicName, setTopicName] = useState('')
  const [topicDescription, setTopicDescription] = useState('')
  const [topicError, setTopicError] = useState('')

  const [showPathModal, setShowPathModal] = useState(false)
  const [scanPath, setScanPath] = useState('')
  const [scanError, setScanError] = useState('')
  const [isSelectingDirectory, setIsSelectingDirectory] = useState(false)
  const [isScanningResources, setIsScanningResources] = useState(false)
  const [showFeedbackModal, setShowFeedbackModal] = useState(false)
  const [feedbackContent, setFeedbackContent] = useState('')
  const [feedbackError, setFeedbackError] = useState('')
  const [isSubmittingFeedback, setIsSubmittingFeedback] = useState(false)
  const [expandedResourceNodeIds, setExpandedResourceNodeIds] = useState<string[]>([])

  const [galleryPath, setGalleryPath] = useState('')
  const [galleryCurrentPath, setGalleryCurrentPath] = useState('')
  const [galleryImages, setGalleryImages] = useState<GalleryImage[]>([])
  const [selectedGalleryImageId, setSelectedGalleryImageId] = useState<string | null>(null)
  const [galleryError, setGalleryError] = useState('')
  const [isScanningGallery, setIsScanningGallery] = useState(false)
  const [isCopyingGalleryImage, setIsCopyingGalleryImage] = useState(false)
  const [isDeletingGalleryImage, setIsDeletingGalleryImage] = useState(false)
  const [isLoadingGalleryPrompt, setIsLoadingGalleryPrompt] = useState(false)
  const [gallerySortMode, setGallerySortMode] = useState<'latest' | 'oldest' | 'name'>('latest')
  const [isGalleryPreviewOpen, setIsGalleryPreviewOpen] = useState(false)
  const [galleryZoom, setGalleryZoom] = useState(1)
  const [galleryPreviewOffset, setGalleryPreviewOffset] = useState({ x: 0, y: 0 })
  const [isGalleryPreviewDragging, setIsGalleryPreviewDragging] = useState(false)
  const [galleryPreviewDragStart, setGalleryPreviewDragStart] = useState({ x: 0, y: 0 })
  const [selectedGalleryImageIds, setSelectedGalleryImageIds] = useState<string[]>([])
  const [isMultiSelectMode, setIsMultiSelectMode] = useState(false)
  const [isGalleryCompareOpen, setIsGalleryCompareOpen] = useState(false)
  const [compareZoom, setCompareZoom] = useState(COMPARE_DEFAULT_ZOOM)
  const [compareOffset, setCompareOffset] = useState({ x: 0, y: 0 })
  const [isCompareDragging, setIsCompareDragging] = useState(false)
  const [compareDragStart, setCompareDragStart] = useState({ x: 0, y: 0 })
  const autoLoadedGalleryPathRef = useRef('')

  const selectedTutorial = tutorials.find((tutorial) => tutorial.id === selectedTutorialId) || null
  const currentTopic = topics.find((topic) => topic.id === selectedTopicId) || null
  const isSearching = searchKeyword.trim().length > 0
  const selectedGalleryImage =
    galleryImages.find((image) => image.type === 'file' && image.id === selectedGalleryImageId) || null
  const comparedGalleryImages = galleryImages
    .filter((image) => image.type === 'file' && selectedGalleryImageIds.includes(image.id))
    .slice(0, 4)
  const isGalleryAtRoot =
    !galleryPath.trim() ||
    !galleryCurrentPath.trim() ||
    normalizePath(galleryCurrentPath).replace(/\/$/, '') === normalizePath(galleryPath).replace(/\/$/, '')
  const visibleGalleryImages = useMemo(() => {
    const nextFolders = galleryImages
      .filter((image) => image.type === 'folder')
      .sort((first, second) => first.name.localeCompare(second.name, 'zh-CN'))
    const nextFiles = galleryImages.filter((image) => image.type === 'file')

    if (gallerySortMode === 'oldest') {
      nextFiles.sort((first, second) => Number(first.modifiedTimestamp || 0) - Number(second.modifiedTimestamp || 0))
      return [...nextFolders, ...nextFiles]
    }

    if (gallerySortMode === 'name') {
      nextFiles.sort((first, second) => first.name.localeCompare(second.name, 'zh-CN'))
      return [...nextFolders, ...nextFiles]
    }

    nextFiles.sort((first, second) => Number(second.modifiedTimestamp || 0) - Number(first.modifiedTimestamp || 0))
    return [...nextFolders, ...nextFiles]
  }, [galleryImages, gallerySortMode])

  useEffect(() => {
    loadResourcesByDesktopApi()
      .then((savedData) => {
        const savedTopics = (savedData?.topics && savedData.topics.length > 0 ? savedData.topics : defaultTopics).map(
          (topic) => ({
            ...topic,
            name: replaceDisplayBrandText(topic.name),
            description: replaceDisplayBrandText(topic.description),
          }),
        )
        const savedTutorials =
          (savedData?.tutorials && savedData.tutorials.length > 0 ? savedData.tutorials : initialTutorials).map(
            (tutorial) => ({
              ...tutorial,
              title: replaceDisplayBrandText(tutorial.title),
            }),
          )
        const savedGalleryPath = savedData?.galleryPath || ''

        setTopics(savedTopics)
        setTutorials(savedTutorials)
        setGalleryPath(savedGalleryPath)
        setGalleryCurrentPath(savedGalleryPath)

        const firstTutorial = savedTutorials[0]
        const firstTopicId = firstTutorial?.topicId || savedTopics[0]?.id || defaultTopics[0].id

        setSelectedTopicId(firstTopicId)
        setSelectedTutorialId(firstTutorial?.id || null)
        setTopicId(firstTopicId)
      })
      .finally(() => {
        hasLoadedSavedData.current = true
      })
  }, [])

  useEffect(() => {
    if (!hasLoadedSavedData.current) {
      return
    }

    saveAppDataByDesktopApi(tutorials, topics, galleryPath).catch((error) => {
      console.error('保存教程数据失败', error)
    })
  }, [tutorials, topics, galleryPath])

  useEffect(() => {
    const handleWindowClick = () => {
      setOpenTopicMenuId(null)
      setOpenTutorialMenuId(null)
    }

    window.addEventListener('click', handleWindowClick)
    return () => window.removeEventListener('click', handleWindowClick)
  }, [])

  useEffect(() => {
    if (selectedGalleryImageId && !galleryImages.some((image) => image.type === 'file' && image.id === selectedGalleryImageId)) {
      setSelectedGalleryImageId(galleryImages.find((image) => image.type === 'file')?.id || null)
    }
  }, [galleryImages, selectedGalleryImageId])

  useEffect(() => {
    setSelectedGalleryImageIds((current) =>
      current.filter((id) => galleryImages.some((image) => image.type === 'file' && image.id === id)),
    )
  }, [galleryImages])

  useEffect(() => {
    if (selectedGalleryImageIds.length === 0) {
      setIsMultiSelectMode(false)
    }
  }, [selectedGalleryImageIds])

  useEffect(() => {
    if (!isGalleryPreviewOpen) {
      setGalleryZoom(1)
      setGalleryPreviewOffset({ x: 0, y: 0 })
      setIsGalleryPreviewDragging(false)
    }
  }, [isGalleryPreviewOpen, selectedGalleryImageId])

  useEffect(() => {
    if (!isGalleryCompareOpen) {
      setCompareZoom(COMPARE_DEFAULT_ZOOM)
      setCompareOffset({ x: 0, y: 0 })
      setIsCompareDragging(false)
    }
  }, [isGalleryCompareOpen])

  useEffect(() => {
    if (galleryZoom <= 1) {
      setGalleryPreviewOffset({ x: 0, y: 0 })
      setIsGalleryPreviewDragging(false)
    }
  }, [galleryZoom])

  useEffect(() => {
    if (!selectedGalleryImage || selectedGalleryImage.type !== 'file') {
      return
    }

    if (typeof selectedGalleryImage.prompt === 'string' && selectedGalleryImage.prompt.length > 0) {
      return
    }

    let isCancelled = false

    const loadPrompt = async () => {
      try {
        setIsLoadingGalleryPrompt(true)
        const result = await readGalleryPromptByDesktopApi(selectedGalleryImage.path)

        if (isCancelled) {
          return
        }

        setGalleryImages((current) =>
          current.map((image) =>
            image.id === selectedGalleryImage.id
              ? {
                  ...image,
                  prompt: result.prompt || '',
                }
              : image,
          ),
        )
      } catch {
        if (isCancelled) {
          return
        }

        setGalleryImages((current) =>
          current.map((image) =>
            image.id === selectedGalleryImage.id
              ? {
                  ...image,
                  prompt: '',
                }
              : image,
          ),
        )
      } finally {
        if (!isCancelled) {
          setIsLoadingGalleryPrompt(false)
        }
      }
    }

    void loadPrompt()

    return () => {
      isCancelled = true
    }
  }, [selectedGalleryImage?.id, selectedGalleryImage?.path])

  useEffect(() => {
    if (!selectedGalleryImage || selectedGalleryImage.type !== 'file') {
      return
    }

    if (typeof selectedGalleryImage.imageUrl === 'string' && selectedGalleryImage.imageUrl.length > 0) {
      return
    }

    let isCancelled = false

    const loadImage = async () => {
      try {
        const result = await readGalleryImageByDesktopApi(selectedGalleryImage.path)

        if (isCancelled) {
          return
        }

        setGalleryImages((current) =>
          current.map((image) =>
            image.id === selectedGalleryImage.id
              ? {
                  ...image,
                  imageUrl: result.imageUrl || '',
                }
              : image,
          ),
        )
      } catch {
        if (isCancelled) {
          return
        }

        setGalleryImages((current) =>
          current.map((image) =>
            image.id === selectedGalleryImage.id
              ? {
                  ...image,
                  imageUrl: image.imageUrl || '',
                }
              : image,
          ),
        )
      }
    }

    void loadImage()

    return () => {
      isCancelled = true
    }
  }, [selectedGalleryImage?.id, selectedGalleryImage?.path, selectedGalleryImage?.imageUrl])

  useEffect(() => {
    if (!isGalleryCompareOpen || comparedGalleryImages.length === 0) {
      return
    }

    const pendingImages = comparedGalleryImages.filter((image) => !image.imageUrl)

    if (pendingImages.length === 0) {
      return
    }

    let isCancelled = false

    const loadCompareImages = async () => {
      const results = await Promise.all(
        pendingImages.map(async (image) => {
          try {
            const result = await readGalleryImageByDesktopApi(image.path)
            return { id: image.id, imageUrl: result.imageUrl || '' }
          } catch {
            return { id: image.id, imageUrl: '' }
          }
        }),
      )

      if (isCancelled) {
        return
      }

      const imageUrlMap = new Map(results.filter((item) => item.imageUrl).map((item) => [item.id, item.imageUrl]))

      if (imageUrlMap.size === 0) {
        return
      }

      setGalleryImages((current) =>
        current.map((image) =>
          imageUrlMap.has(image.id)
            ? {
                ...image,
                imageUrl: imageUrlMap.get(image.id),
              }
            : image,
        ),
      )
    }

    void loadCompareImages()

    return () => {
      isCancelled = true
    }
  }, [isGalleryCompareOpen, comparedGalleryImages])

  useEffect(() => {
    const cleanPath = (galleryCurrentPath || galleryPath).trim()

    if (!cleanPath || activeSidebarView !== 'gallery' || isScanningGallery) {
      return
    }

    if (autoLoadedGalleryPathRef.current === cleanPath) {
      return
    }

    void scanGallery(cleanPath)
  }, [activeSidebarView, galleryCurrentPath, galleryPath, galleryImages.length, isScanningGallery])

  const filteredTutorials = useMemo(() => {
    const keyword = searchKeyword.trim().toLowerCase()

    if (keyword) {
      return tutorials.filter((tutorial) => {
        const topicName = topics.find((topic) => topic.id === tutorial.topicId)?.name || ''
        const searchableText = [
          tutorial.title,
          tutorial.author,
          tutorial.url,
          tutorial.tags.join(' '),
          topicName,
        ]
          .join(' ')
          .toLowerCase()

        return searchableText.includes(keyword)
      })
    }

    return tutorials.filter((tutorial) => tutorial.topicId === selectedTopicId)
  }, [tutorials, topics, selectedTopicId, searchKeyword])

  const openGalleryView = () => {
    setSearchKeyword('')
    setActiveSidebarView('gallery')
  }

  const toggleTopic = (id: string) => {
    setSearchKeyword('')
    setActiveSidebarView('tutorials')
    setSelectedTopicId(id)
    setOpenTopicMenuId(null)
  }

  const fetchBilibiliInfo = async () => {
    const inputUrl = url.trim()

    if (!inputUrl) {
      setVideoInfoError('请先粘贴 B 站教程链接')
      return
    }

    if (!getBilibiliVideoKey(inputUrl)) {
      setVideoInfoError('没有识别到 BV 号或 AV 号，请检查链接')
      return
    }

    try {
      setIsFetchingVideoInfo(true)
      setVideoInfoError('')

      const result = await fetchBilibiliInfoByDesktopApi(inputUrl)

      if (!result.title) {
        throw new Error('没有获取到视频标题')
      }

      setTitle(result.title)
      setAuthor(result.author || '未知 UP 主')
    } catch (error) {
      setVideoInfoError(error instanceof Error ? error.message : '获取失败，请确认链接正确，或稍后再试')
    } finally {
      setIsFetchingVideoInfo(false)
    }
  }

  const resetForm = () => {
    setUrl('')
    setTitle('')
    setAuthor('')
    setTopicId(topics[0]?.id || defaultTopics[0].id)
    setTags('')
    setVideoInfoError('')
    setEditingTutorialId(null)
  }

  const openAddTutorialModal = () => {
    resetForm()
    setTopicId(selectedTopicId || topics[0]?.id || defaultTopics[0].id)
    setShowAddModal(true)
  }

  const closeTutorialModal = () => {
    resetForm()
    setShowAddModal(false)
  }

  const editTutorial = (tutorial: Tutorial) => {
    setEditingTutorialId(tutorial.id)
    setUrl(tutorial.url)
    setTitle(tutorial.title)
    setAuthor(tutorial.author)
    setTopicId(tutorial.topicId)
    setTags(tutorial.tags.join(', '))
    setVideoInfoError('')
    setShowAddModal(true)
  }

  const addTutorial = () => {
    if (!url.trim() || !title.trim()) {
      return
    }

    const safeTopicId = topicId || topics[0]?.id || defaultTopics[0].id
    const currentVideoKey = getBilibiliVideoKey(url)

    const duplicatedTutorial = tutorials.find((tutorial) => {
      if (editingTutorialId && tutorial.id === editingTutorialId) {
        return false
      }

      const sameUrl = tutorial.url.trim() === url.trim()
      const sameVideoKey = currentVideoKey && getBilibiliVideoKey(tutorial.url) === currentVideoKey
      return sameUrl || sameVideoKey
    })

    if (duplicatedTutorial) {
      setVideoInfoError(`教程已存在：${duplicatedTutorial.title}`)
      return
    }

    const tutorialData = {
      title: title.trim(),
      author: author.trim() || '未知 UP 主',
      url: url.trim(),
      topicId: safeTopicId,
      tags: tags
        .split(/[,，]/)
        .map((tag) => tag.trim())
        .filter(Boolean),
    }

    if (editingTutorialId) {
      setTutorials((current) =>
        current.map((tutorial) =>
          tutorial.id === editingTutorialId
            ? {
                ...tutorial,
                ...tutorialData,
              }
            : tutorial,
        ),
      )

      setActiveSidebarView('tutorials')
      setSelectedTopicId(safeTopicId)
      setSelectedTutorialId(editingTutorialId)
      setShowAddModal(false)
      resetForm()
      return
    }

    const tutorial: Tutorial = {
      id: crypto.randomUUID(),
      ...tutorialData,
      resourcePath: '',
      resources: createEmptyResources(),
    }

    setTutorials((current) => [tutorial, ...current])
    setActiveSidebarView('tutorials')
    setSelectedTopicId(safeTopicId)
    setSelectedTutorialId(tutorial.id)
    setShowAddModal(false)
    resetForm()
  }

  const deleteTutorial = async (id: string) => {
    const tutorial = tutorials.find((item) => item.id === id)
    const { confirmed: shouldDelete } = await showConfirmDialogByDesktopApi({
      title: '通知',
      message: `确定要删除「${tutorial?.title || '当前教程'}」吗？`,
      detail: '删除后会从教程列表中移除。',
      confirmText: '确定',
      cancelText: '取消',
    })

    if (!shouldDelete) {
      return
    }

    confirmDeleteTutorial(id)
  }

  const confirmDeleteTutorial = (targetId?: string) => {
    const tutorialId = targetId

    if (!tutorialId) {
      return
    }

    setTutorials((current) => current.filter((item) => item.id !== tutorialId))

    if (selectedTutorialId === tutorialId) {
      const nextTutorial = tutorials.find((item) => item.id !== tutorialId) || null
      setSelectedTutorialId(nextTutorial?.id || null)
    }

    if (editingTutorialId === tutorialId) {
      resetForm()
      setShowAddModal(false)
    }

  }

  const openAddTopicModal = () => {
    setEditingTopicId(null)
    setTopicName('')
    setTopicDescription('')
    setTopicError('')
    setShowTopicModal(true)
  }

  const editTopic = (topic: Topic) => {
    setOpenTopicMenuId(null)
    setEditingTopicId(topic.id)
    setTopicName(topic.name)
    setTopicDescription(topic.description)
    setTopicError('')
    setShowTopicModal(true)
  }

  const closeTopicModal = () => {
    setEditingTopicId(null)
    setTopicName('')
    setTopicDescription('')
    setTopicError('')
    setShowTopicModal(false)
  }

  const saveTopic = () => {
    const cleanName = topicName.trim()
    const cleanDescription = topicDescription.trim()

    if (!cleanName) {
      setTopicError('请填写主题名称')
      return
    }

    if (isLikelyUrl(cleanName)) {
      setTopicError('主题名称不能填写链接，请输入简短名称，例如：文生图')
      return
    }

    if (cleanName.length > TOPIC_NAME_MAX_LENGTH) {
      setTopicError(`主题名称最多 ${TOPIC_NAME_MAX_LENGTH} 个字符`)
      return
    }

    if (editingTopicId) {
      setTopics((current) =>
        current.map((topic) =>
          topic.id === editingTopicId
            ? {
                ...topic,
                name: cleanName,
                description: cleanDescription,
              }
            : topic,
        ),
      )
      closeTopicModal()
      return
    }

    const nextTopic: Topic = {
      id: crypto.randomUUID(),
      name: cleanName,
      description: cleanDescription,
    }

    setTopics((current) => [...current, nextTopic])
    setActiveSidebarView('tutorials')
    setSelectedTopicId(nextTopic.id)
    setTopicId(nextTopic.id)
    closeTopicModal()
  }

  const deleteTopic = async (topic: Topic) => {
    setOpenTopicMenuId(null)
    if (topics.length <= 1) {
      setTopicError('至少需要保留一个主题')
      return
    }

    const { confirmed: shouldDelete } = await showConfirmDialogByDesktopApi({
      title: '通知',
      message: `确定要删除主题「${topic.name}」吗？`,
      detail: '该主题下的教程会自动转移到其他主题。',
      confirmText: '确定',
      cancelText: '取消',
    })

    if (!shouldDelete) {
      return
    }

    const fallbackTopic = topics.find((item) => item.id !== topic.id)

    if (!fallbackTopic) {
      return
    }

    setTutorials((current) =>
      current.map((tutorial) =>
        tutorial.topicId === topic.id
          ? {
              ...tutorial,
              topicId: fallbackTopic.id,
            }
          : tutorial,
      ),
    )

    setTopics((current) => current.filter((item) => item.id !== topic.id))
    setSelectedTopicId(fallbackTopic.id)
    setTopicId(fallbackTopic.id)
    closeTopicModal()
  }

  const openPathModal = () => {
    if (!selectedTutorial) {
      return
    }

    setScanPath(selectedTutorial.resourcePath)
    setScanError('')
    setShowPathModal(true)
  }

  const closePathModal = () => {
    if (isScanningResources || isSelectingDirectory) {
      return
    }

    setShowPathModal(false)
    setScanPath('')
    setScanError('')
  }

  const chooseDirectory = async () => {
    try {
      setIsSelectingDirectory(true)
      setScanError('')

      const selectedPath = await selectDirectoryByDesktopApi()

      if (selectedPath) {
        setScanPath(selectedPath)
      }
    } catch (error) {
      setScanError(error instanceof Error ? error.message : '选择目录失败')
    } finally {
      setIsSelectingDirectory(false)
    }
  }

  const scanResources = async () => {
    if (!selectedTutorial) {
      return
    }

    const cleanPath = scanPath.trim()

    if (!cleanPath) {
      setScanError('请先手动填写绝对路径，或点击选择目录')
      return
    }

    try {
      setIsScanningResources(true)
      setScanError('')

      const scannedResult = await scanDirectoryByDesktopApi(cleanPath)
      const nextResources = isResourceNodeArray(scannedResult)
        ? normalizeScannedTree(cleanPath, scannedResult)
        : createResourceTreeFromScannedItems(cleanPath, scannedResult)

      setTutorials((current) =>
        current.map((tutorial) =>
          tutorial.id === selectedTutorial.id
            ? {
                ...tutorial,
                resourcePath: cleanPath,
                resources: nextResources,
              }
            : tutorial,
        ),
      )

      setExpandedResourceNodeIds([cleanPath])
      closePathModal()
    } catch (error) {
      setScanError(error instanceof Error ? error.message : '扫描失败，请检查路径是否存在')
    } finally {
      setIsScanningResources(false)
    }
  }

  const chooseGalleryDirectory = async () => {
    try {
      setGalleryError('')
      const selectedPath = await selectDirectoryByDesktopApi()

      if (selectedPath) {
        setGalleryPath(selectedPath)
        setGalleryCurrentPath(selectedPath)
        autoLoadedGalleryPathRef.current = ''
        void scanGallery(selectedPath, { rootPath: selectedPath })
      }
    } catch (error) {
      setGalleryError(error instanceof Error ? error.message : '选择图库目录失败')
    }
  }

  const scanGallery = async (pathOverride?: string, options?: { rootPath?: string }) => {
    const cleanPath = (pathOverride || galleryCurrentPath || galleryPath).trim()

    if (!cleanPath) {
      setGalleryError('请先设置图片目录')
      return
    }

    try {
      setIsScanningGallery(true)
      setGalleryError('')
      autoLoadedGalleryPathRef.current = cleanPath
      const images = await scanGalleryDirectoryByDesktopApi(cleanPath)
      if (options?.rootPath) {
        setGalleryPath(options.rootPath)
      }
      setGalleryCurrentPath(cleanPath)
      setGalleryImages(images)
      setSelectedGalleryImageId(images.find((image) => image.type === 'file')?.id || null)
    } catch (error) {
      autoLoadedGalleryPathRef.current = ''
      setGalleryError(error instanceof Error ? error.message : '读取图库失败')
    } finally {
      setIsScanningGallery(false)
    }
  }

  const openGalleryImagePreview = (imageId: string) => {
    setSelectedGalleryImageId(imageId)
    setIsGalleryPreviewOpen(true)
  }

  const copyGalleryImage = async () => {
    if (!selectedGalleryImage) {
      return
    }

    try {
      setIsCopyingGalleryImage(true)
      setGalleryError('')
      await copyGalleryImageByDesktopApi(selectedGalleryImage.path)
    } catch (error) {
      setGalleryError(error instanceof Error ? error.message : '复制图片失败')
    } finally {
      setIsCopyingGalleryImage(false)
    }
  }

  const deleteGalleryImage = async () => {
    if (!selectedGalleryImage) {
      return
    }

    const { confirmed: shouldDelete } = await showConfirmDialogByDesktopApi({
      title: '通知',
      message: `是否将「${selectedGalleryImage.name}」移动到回收站？`,
      confirmText: '确定',
      cancelText: '取消',
    })

    if (!shouldDelete) {
      return
    }

    try {
      setIsDeletingGalleryImage(true)
      setGalleryError('')
      await deleteGalleryImageByDesktopApi(selectedGalleryImage.path)
      const nextImages = galleryImages.filter((image) => image.id !== selectedGalleryImage.id)
      setGalleryImages(nextImages)
      setSelectedGalleryImageId(nextImages.find((image) => image.type === 'file')?.id || null)
    } catch (error) {
      setGalleryError(error instanceof Error ? error.message : '删除图片失败')
    } finally {
      setIsDeletingGalleryImage(false)
    }
  }

  const deleteComparedGalleryImage = async (imageId: string) => {
    const targetImage = galleryImages.find((image) => image.type === 'file' && image.id === imageId)

    if (!targetImage) {
      return
    }

    const { confirmed: shouldDelete } = await showConfirmDialogByDesktopApi({
      title: '通知',
      message: `是否将「${targetImage.name}」移动到回收站？`,
      confirmText: '确定',
      cancelText: '取消',
    })

    if (!shouldDelete) {
      return
    }

    try {
      setIsDeletingGalleryImage(true)
      setGalleryError('')
      await deleteGalleryImageByDesktopApi(targetImage.path)

      const nextImages = galleryImages.filter((image) => image.id !== imageId)
      const nextSelectedIds = selectedGalleryImageIds.filter((id) => id !== imageId)

      setGalleryImages(nextImages)
      setSelectedGalleryImageIds(nextSelectedIds)

      if (selectedGalleryImageId === imageId) {
        setSelectedGalleryImageId(nextImages.find((image) => image.type === 'file')?.id || null)
      }

      if (nextSelectedIds.length < 2) {
        setIsGalleryCompareOpen(false)
      }
    } catch (error) {
      setGalleryError(error instanceof Error ? error.message : '删除图片失败')
    } finally {
      setIsDeletingGalleryImage(false)
    }
  }

  const toggleGallerySelection = (imageId: string) => {
    setSelectedGalleryImageIds((current) => {
      const nextSelection = current.includes(imageId)
        ? current.filter((id) => id !== imageId)
        : [...current, imageId]

      setIsMultiSelectMode(nextSelection.length > 0)
      return nextSelection
    })
  }

  const cancelGallerySelection = () => {
    setIsMultiSelectMode(false)
    setSelectedGalleryImageIds([])
  }

  const selectAllVisibleGalleryImages = () => {
    const nextSelection = visibleGalleryImages.filter((image) => image.type === 'file').map((image) => image.id)
    if (nextSelection.length === 0) {
      return
    }

    setIsMultiSelectMode(true)
    setSelectedGalleryImageIds(nextSelection)
  }

  const goToParentGalleryDirectory = () => {
    if (isGalleryAtRoot || !galleryCurrentPath.trim()) {
      return
    }

    const parentPath = normalizePath(galleryCurrentPath).replace(/\/$/, '').split('/').slice(0, -1).join('/')

    if (!parentPath) {
      return
    }

    cancelGallerySelection()
    void scanGallery(parentPath)
  }

  const openCurrentGalleryPath = async () => {
    const cleanPath = (galleryCurrentPath || galleryPath).trim()

    if (!cleanPath) {
      setGalleryError('请先设置图片目录')
      return
    }

    try {
      setGalleryError('')
      await openGalleryPathByDesktopApi(cleanPath)
    } catch (error) {
      setGalleryError(error instanceof Error ? error.message : '打开当前文件夹失败')
    }
  }

  const revealCurrentGalleryImage = async () => {
    if (!selectedGalleryImage) {
      return
    }

    try {
      setGalleryError('')
      await revealGalleryItemByDesktopApi(selectedGalleryImage.path)
    } catch (error) {
      setGalleryError(error instanceof Error ? error.message : '打开图片所在文件夹失败')
    }
  }

  const importDroppedGalleryImages = async (event: DragEvent<HTMLDivElement>) => {
    event.preventDefault()

    const cleanPath = (galleryCurrentPath || galleryPath).trim()

    if (!cleanPath) {
      setGalleryError('请先设置图片目录')
      return
    }

    const droppedPaths = Array.from(event.dataTransfer.files || [])
      .map((file) => file.path)
      .filter((path) => path && isSupportedImagePath(path))

    if (droppedPaths.length === 0) {
      setGalleryError('只支持拖入图片文件')
      return
    }

    try {
      setGalleryError('')
      const result = await importGalleryImagesByDesktopApi({
        targetDirectory: cleanPath,
        paths: droppedPaths,
      })

      if (result.duplicateNames?.length) {
        showNoticeAlert(`以下文件名已存在，未重复导入：\n${result.duplicateNames.join('\n')}`)
      }

      await scanGallery(cleanPath)
    } catch (error) {
      setGalleryError(error instanceof Error ? error.message : '导入图片失败')
    }
  }

  const copySelectedGalleryImages = async () => {
    if (selectedGalleryImageIds.length === 0) {
      return
    }

    try {
      const selectedPaths = galleryImages
        .filter((image) => image.type === 'file' && selectedGalleryImageIds.includes(image.id))
        .map((image) => image.path)
      const targetDirectory = await selectDirectoryByDesktopApi()

      if (!targetDirectory) {
        return
      }

      setGalleryError('')
      await copyGalleryImagesToDirectoryByDesktopApi({
        targetDirectory,
        paths: selectedPaths,
      })
    } catch (error) {
      setGalleryError(error instanceof Error ? error.message : '批量复制图片失败')
    }
  }

  const moveSelectedGalleryImages = async () => {
    if (selectedGalleryImageIds.length === 0) {
      return
    }

    try {
      const selectedPaths = galleryImages
        .filter((image) => image.type === 'file' && selectedGalleryImageIds.includes(image.id))
        .map((image) => image.path)
      const targetDirectory = await selectDirectoryByDesktopApi()

      if (!targetDirectory) {
        return
      }

      setGalleryError('')
      await moveGalleryImagesToDirectoryByDesktopApi({
        targetDirectory,
        paths: selectedPaths,
      })

      const nextImages = galleryImages.filter((image) => !selectedGalleryImageIds.includes(image.id))
      setGalleryImages(nextImages)
      setSelectedGalleryImageId(nextImages.find((image) => image.type === 'file')?.id || null)
      cancelGallerySelection()
    } catch (error) {
      setGalleryError(error instanceof Error ? error.message : '批量移动图片失败')
    }
  }

  const deleteSelectedGalleryImages = async () => {
    if (selectedGalleryImageIds.length === 0) {
      return
    }

    const { confirmed: shouldDelete } = await showConfirmDialogByDesktopApi({
      title: '通知',
      message: `是否将选中的 ${selectedGalleryImageIds.length} 张图片移动到回收站？`,
      confirmText: '确定',
      cancelText: '取消',
    })

    if (!shouldDelete) {
      return
    }

    try {
      const selectedPaths = galleryImages
        .filter((image) => image.type === 'file' && selectedGalleryImageIds.includes(image.id))
        .map((image) => image.path)

      setGalleryError('')
      await deleteGalleryImagesByDesktopApi(selectedPaths)
      const nextImages = galleryImages.filter((image) => !selectedGalleryImageIds.includes(image.id))
      setGalleryImages(nextImages)
      setSelectedGalleryImageId(nextImages.find((image) => image.type === 'file')?.id || null)
      cancelGallerySelection()
    } catch (error) {
      setGalleryError(error instanceof Error ? error.message : '批量删除图片失败')
    }
  }

  const openGalleryCompare = () => {
    if (selectedGalleryImageIds.length < 2) {
      return
    }

    setIsGalleryCompareOpen(true)
  }

  const copyCurrentPrompt = async () => {
    if (!selectedGalleryImage?.prompt) {
      return
    }

    try {
      await navigator.clipboard.writeText(selectedGalleryImage.prompt)
    } catch {
      setGalleryError('复制提示词失败')
    }
  }

  const toggleResourceNode = (id: string) => {
    setExpandedResourceNodeIds((current) =>
      current.includes(id) ? current.filter((nodeId) => nodeId !== id) : [...current, id],
    )
  }

  const submitFeedback = async () => {
    const cleanContent = feedbackContent.trim()

    if (!cleanContent) {
      setFeedbackError('请先填写反馈内容')
      return
    }

    try {
      setIsSubmittingFeedback(true)
      setFeedbackError('')
      await submitFeedbackByDesktopApi({
        content: cleanContent,
        page: activeSidebarView === 'gallery' ? '图库资源管理' : '教程资源',
      })
      await showAlertDialogByDesktopApi({
        title: '通知',
        message: '反馈已提交',
        buttonText: '确定',
      })
      setFeedbackContent('')
      setShowFeedbackModal(false)
    } catch (error) {
      setFeedbackError(error instanceof Error ? error.message : '反馈提交失败')
    } finally {
      setIsSubmittingFeedback(false)
    }
  }

  return (
    <main className={`app-shell ${themeMode === 'light' ? 'light-mode' : 'dark-mode'}`}>
      <aside className="side-nav">
        <div className="brand">
          <div className="brand-logo">
            <img src="/brand-logo.png" alt="AI绘画资源管理" />
          </div>
          <div>
            <strong>AI绘画资源管理</strong>
            <span>
              BY{' '}
              <a href="https://space.bilibili.com/433816771" target="_blank" rel="noreferrer">
                Mooyan
              </a>
            </span>
          </div>
        </div>

        <div className="sidebar-scroll-area">
          <div className="topic-panel">
            <div className="panel-title">快捷入口</div>

            <div className="topic-card">
              <button
                type="button"
                className={`topic-button ${activeSidebarView === 'gallery' ? 'active' : ''}`}
                onClick={openGalleryView}
              >
                <span className="topic-button-copy">
                  <strong>图库</strong>
                  <small>管理本地图片与提示词</small>
                </span>
              </button>
            </div>
          </div>

          <div className="topic-panel">
            <div className="panel-title">教程主题</div>

            <div className="sidebar-search topic-search-block">
              <label>
                搜索
                <input
                  value={searchKeyword}
                  onChange={(event) => setSearchKeyword(event.target.value)}
                  placeholder="标题、UP 主、标签"
                  disabled={activeSidebarView === 'gallery'}
                />
              </label>
              {isSearching && activeSidebarView === 'tutorials' && (
                <button type="button" className="clear-search-button" onClick={() => setSearchKeyword('')}>
                  清空搜索
                </button>
              )}
            </div>

            {topics.map((topic) => {
              const isMenuOpen = openTopicMenuId === topic.id

              return (
                <div key={topic.id} className="topic-group">
                  <div
                    className={`topic-card ${
                      activeSidebarView === 'tutorials' && selectedTopicId === topic.id && !isSearching
                        ? 'active'
                        : ''
                    }`}
                  >
                    <button
                      type="button"
                      className={`topic-button ${
                        activeSidebarView === 'tutorials' && selectedTopicId === topic.id && !isSearching
                          ? 'active'
                          : ''
                      }`}
                      title={topic.description ? `${topic.name}\n${topic.description}` : topic.name}
                      onClick={() => toggleTopic(topic.id)}
                    >
                      <span className="topic-button-copy">
                        <strong>{topic.name}</strong>
                        <small>{topic.description}</small>
                      </span>
                    </button>

                    {!isSearching && (
                      <div className="topic-card-tools">
                        <button
                          type="button"
                          className={`topic-menu-trigger ${isMenuOpen ? 'active' : ''}`}
                          aria-label={`${topic.name} 操作菜单`}
                          onClick={(event) => {
                            event.stopPropagation()
                            setOpenTopicMenuId((current) => (current === topic.id ? null : topic.id))
                          }}
                        >
                          <span className="topic-menu-dots" aria-hidden="true">
                            <span />
                            <span />
                            <span />
                          </span>
                        </button>
                        {isMenuOpen && (
                          <div className="topic-menu">
                            <button type="button" onClick={() => editTopic(topic)}>
                              重新编辑
                            </button>
                            <button type="button" className="danger" onClick={() => deleteTopic(topic)}>
                              删除
                            </button>
                          </div>
                        )}
                      </div>
                    )}
                  </div>
                </div>
              )
            })}
          </div>

        </div>

        <div className="sidebar-footer-panel">
        <button type="button" className="add-topic-button" onClick={openAddTopicModal}>
          + 添加主题
        </button>
        </div>
      </aside>

      <section className="main-view">
        <header className="top-bar">
          <div>
            <h1>{activeSidebarView === 'gallery' ? '图库资源管理' : '教程资源'}</h1>
            <span>
              {activeSidebarView === 'gallery'
                ? '设置本地图片目录，查看缩略图与提示词。'
                : '管理教程、主题与资源信息。'}
            </span>
          </div>

          <div className="top-actions">
            <button
              type="button"
              className="feedback-toggle"
              onClick={() => {
                setFeedbackError('')
                setShowFeedbackModal(true)
              }}
            >
              反馈
            </button>
            <button
              type="button"
              className="theme-toggle"
              onClick={() => setThemeMode((current) => (current === 'dark' ? 'light' : 'dark'))}
              aria-label="切换主题"
            >
              {themeMode === 'dark' ? '🌙' : '☀️'}
            </button>
          </div>
        </header>

        {activeSidebarView === 'gallery' ? (
          <section className="content-grid gallery-layout">
            <article className="detail-section gallery-browser-section">
              <div className="gallery-browser-header">
                <p className="gallery-tip">
                  浏览图库内文件，单击卡片后在右侧查看提示词，双击预览图片，将图片拖动至下方会复制到当前目录中。
                </p>

                <div className="gallery-path-bar">
                  <div className="gallery-path-copy">
                    <span className="gallery-path-label">当前路径:</span>
                    <span className="gallery-path-value">{galleryCurrentPath || galleryPath || '未设置图片目录'}</span>
                  </div>
                  <button type="button" className="ghost-button" onClick={chooseGalleryDirectory}>
                    选择目录
                  </button>
                </div>

                <div className="gallery-controls">
                  <label className="gallery-sort-label">
                    <span>排序方式</span>
                    <select
                      className="gallery-sort"
                      value={gallerySortMode}
                      onChange={(event) => setGallerySortMode(event.target.value as 'latest' | 'oldest' | 'name')}
                      aria-label="排序方式"
                    >
                      <option value="latest">最新</option>
                      <option value="oldest">最早</option>
                      <option value="name">名称</option>
                    </select>
                  </label>

                  <button type="button" className="ghost-button gallery-select-all" onClick={selectAllVisibleGalleryImages}>
                    全选
                  </button>

                  {!isGalleryAtRoot && (
                    <button type="button" className="ghost-button gallery-select-all" onClick={goToParentGalleryDirectory}>
                      上级目录
                    </button>
                  )}

                  <div className="gallery-toolbar-actions">
                    <button type="button" className="ghost-button" onClick={openCurrentGalleryPath}>
                      打开当前路径
                    </button>
                    <button
                      type="button"
                      className="primary-button small"
                      onClick={() => {
                        void scanGallery()
                      }}
                      disabled={isScanningGallery}
                    >
                      {isScanningGallery ? '刷新中...' : '刷新图库'}
                    </button>
                  </div>
                </div>
              </div>

              {galleryError && <p className="form-error gallery-error">{galleryError}</p>}

              {visibleGalleryImages.length > 0 ? (
                <div className="gallery-grid-summary">共 {visibleGalleryImages.length} 个</div>
              ) : null}

              <div
                className="tutorial-scroll-area gallery-scroll-area"
                onDragOver={(event) => event.preventDefault()}
                onDrop={importDroppedGalleryImages}
              >
                {visibleGalleryImages.length > 0 ? (
                  <>
                    <div className={`gallery-grid ${isMultiSelectMode ? 'multi-select' : ''}`}>
                      {visibleGalleryImages.map((image) => (
                        <button
                          key={image.id}
                          type="button"
                          className={`gallery-thumb-card ${
                            image.type === 'file' && selectedGalleryImageId === image.id ? 'active' : ''
                          } ${selectedGalleryImageIds.includes(image.id) ? 'selected' : ''}`}
                          onClick={() => {
                            if (image.type === 'folder') {
                              cancelGallerySelection()
                              void scanGallery(image.path)
                              return
                            }

                            if (isMultiSelectMode) {
                              toggleGallerySelection(image.id)
                              return
                            }

                            setSelectedGalleryImageId(image.id)
                          }}
                          onDoubleClick={() => {
                            if (image.type === 'file') {
                              openGalleryImagePreview(image.id)
                            }
                          }}
                        >
                          {image.type === 'file' ? (
                            <>
                              <button
                                type="button"
                                className={`gallery-thumb-check ${selectedGalleryImageIds.includes(image.id) ? 'checked' : ''}`}
                                aria-label={`选择 ${image.name}`}
                                onClick={(event) => {
                                  event.stopPropagation()
                                  toggleGallerySelection(image.id)
                                }}
                              />
                              {image.size ? <span className="gallery-thumb-size">{formatFileSize(image.size)}</span> : null}
                              <img src={image.thumbnailUrl || image.imageUrl} alt={image.name} draggable={false} />
                            </>
                          ) : (
                            <div className="gallery-folder-preview" aria-hidden="true">
                              <div className="gallery-folder-icon">📁</div>
                            </div>
                          )}
                          <div className="gallery-thumb-meta">
                            <strong>{image.name}</strong>
                            {image.type === 'file' ? <span>{image.modifiedAt || '-'}</span> : null}
                          </div>
                        </button>
                      ))}
                    </div>
                  </>
                ) : (
                  <div className="empty-state">
                    {galleryPath ? '当前目录没有图片或可浏览的子文件夹，点击上方刷新图库。' : '先设置一个图片目录，再在这里展示缩略图。'}
                  </div>
                )}
              </div>

              {isMultiSelectMode && (
                <div className="gallery-bulk-bar">
                  <span>已选择 {selectedGalleryImageIds.length} 项</span>
                  <div className="gallery-bulk-actions">
                    <button type="button" className="ghost-button" onClick={cancelGallerySelection}>
                      取消选择
                    </button>
                    <button type="button" className="ghost-button" onClick={copySelectedGalleryImages}>
                      复制到
                    </button>
                    <button type="button" className="ghost-button" onClick={moveSelectedGalleryImages}>
                      移动到
                    </button>
                    <button
                      type="button"
                      className="ghost-button"
                      onClick={openGalleryCompare}
                      disabled={selectedGalleryImageIds.length < 2 || selectedGalleryImageIds.length > 4}
                    >
                      对比
                    </button>
                    <button type="button" className="danger-button" onClick={deleteSelectedGalleryImages}>
                      删除选中
                    </button>
                  </div>
                </div>
              )}
            </article>

            <article className="detail-section gallery-detail-section">
              {selectedGalleryImage ? (
                <>
                  <div className="detail-header">
                    <div className="detail-copy">
                      <p className="eyebrow">图片信息</p>
                      <div className="detail-heading-row">
                        <h2>{selectedGalleryImage.name}</h2>

                        <div className="detail-actions">
                          {selectedGalleryImage.prompt ? (
                            <button type="button" className="ghost-button" onClick={copyCurrentPrompt}>
                              复制提示词
                            </button>
                          ) : null}
                          <button
                            type="button"
                            className="danger-button"
                            onClick={deleteGalleryImage}
                            disabled={isDeletingGalleryImage}
                          >
                            {isDeletingGalleryImage ? '删除中...' : '删除图片'}
                          </button>
                        </div>
                      </div>

                      <span className="detail-meta">
                        路径: {selectedGalleryImage.path}
                        {selectedGalleryImage.size ? ` · ${formatFileSize(selectedGalleryImage.size)}` : ''}
                      </span>
                    </div>
                  </div>

                  <div className="gallery-preview">
                    <button
                      type="button"
                      className="gallery-preview-button"
                      onClick={() => setIsGalleryPreviewOpen(true)}
                    >
                      <img
                        src={selectedGalleryImage.imageUrl || selectedGalleryImage.thumbnailUrl}
                        alt={selectedGalleryImage.name}
                      />
                    </button>
                  </div>

                  <div className="gallery-prompt-panel">
                    <p className="eyebrow">提示词</p>
                    <pre>
                      {isLoadingGalleryPrompt
                        ? '正在读取提示词...'
                        : selectedGalleryImage.prompt || '当前图片没有读取到提示词。'}
                    </pre>
                  </div>
                </>
              ) : (
                <div className="empty-detail">请选择一张图片查看提示词、复制和删除操作</div>
              )}
            </article>
          </section>
        ) : (
          <section className="content-grid">
            <article className="tutorial-section">
              <div className="section-header">
                <div className="section-header-copy">
                  <p className="eyebrow">{isSearching ? '搜索结果' : '教程列表'}</p>
                  <div className="section-heading-row">
                    <h2>{isSearching ? `"${searchKeyword.trim()}"` : currentTopic?.name}</h2>

                    <div className="section-header-actions">
                      <span>{filteredTutorials.length} 个教程</span>
                      {!isSearching && (
                        <button type="button" className="primary-button small" onClick={openAddTutorialModal}>
                          + 添加教程
                        </button>
                      )}
                    </div>
                  </div>
                </div>
              </div>

              <div className="tutorial-scroll-area">
                <div className="tutorial-grid">
                  {filteredTutorials.map((tutorial) => {
                    const resourceCount = countResourceFiles(tutorial.resources)

                    return (
                      <button
                        type="button"
                        key={tutorial.id}
                        className={`tutorial-card ${selectedTutorialId === tutorial.id ? 'active' : ''}`}
                        onClick={() => {
                          setSelectedTopicId(tutorial.topicId)
                          setSelectedTutorialId(tutorial.id)
                        }}
                      >
                        <span className="card-glow" />
                        <div className="tutorial-card-tools">
                          <button
                            type="button"
                            className={`topic-menu-trigger ${openTutorialMenuId === tutorial.id ? 'active' : ''}`}
                            aria-label={`${tutorial.title} 操作菜单`}
                            onClick={(event) => {
                              event.stopPropagation()
                              setOpenTutorialMenuId((current) => (current === tutorial.id ? null : tutorial.id))
                            }}
                          >
                            <span className="topic-menu-dots" aria-hidden="true">
                              <span />
                              <span />
                              <span />
                            </span>
                          </button>
                          {openTutorialMenuId === tutorial.id && (
                            <div className="topic-menu">
                              <button
                                type="button"
                                onClick={(event) => {
                                  event.stopPropagation()
                                  editTutorial(tutorial)
                                  setOpenTutorialMenuId(null)
                                }}
                              >
                                编辑
                              </button>
                              <button
                                type="button"
                                className="danger"
                                onClick={(event) => {
                                  event.stopPropagation()
                                  deleteTutorial(tutorial.id)
                                  setOpenTutorialMenuId(null)
                                }}
                              >
                                删除
                              </button>
                            </div>
                          )}
                        </div>

                        <div className="card-top">
                          <strong>{tutorial.title}</strong>
                          <span>{resourceCount} 个文件</span>
                        </div>

                        <p>UP 主：{tutorial.author}</p>

                        <div className="tag-row">
                          {tutorial.tags.map((tag) => (
                            <i key={tag}>{tag}</i>
                          ))}
                        </div>
                      </button>
                    )
                  })}

                  {filteredTutorials.length === 0 && (
                    <div className="empty-state">
                      {isSearching ? '没有找到匹配的教程，删除搜索文字后恢复原列表。' : '当前主题还没有教程，点击右上角添加。'}
                    </div>
                  )}
                </div>
              </div>
            </article>

            <article className="detail-section">
              {selectedTutorial ? (
                <>
                  <div className="detail-header">
                    <div className="detail-copy">
                      <p className="eyebrow">资源列表</p>
                      <div className="detail-heading-row">
                        <button
                          type="button"
                          className="detail-title-button"
                          onClick={() => window.open(selectedTutorial.url, '_blank', 'noopener,noreferrer')}
                        >
                          <h2>{selectedTutorial.title}</h2>
                        </button>

                        <div className="detail-actions">
                          <button type="button" className="primary-button small" onClick={openPathModal}>
                            添加路径并扫描
                          </button>
                        </div>
                      </div>

                      <span className="detail-meta">
                        UP 主：{selectedTutorial.author} · 主题：
                        {topics.find((topic) => topic.id === selectedTutorial.topicId)?.name}
                      </span>
                    </div>
                  </div>

                  <div className="tag-row detail-tags">
                    {selectedTutorial.tags.map((tag) => (
                      <i key={tag}>{tag}</i>
                    ))}
                  </div>

                  <div className="detail-resource-scroll">
                    <ResourceTree
                      nodes={selectedTutorial.resources}
                      expandedIds={expandedResourceNodeIds}
                      onToggle={toggleResourceNode}
                      rootPath={selectedTutorial.resourcePath}
                    />
                  </div>
                </>
              ) : (
                <div className="empty-detail">请选择一个教程查看详情</div>
              )}
            </article>
          </section>
        )}
      </section>

      {showAddModal && (
        <div className="modal-mask">
          <section className="modal">
            <div className="modal-header">
              <div>
                <p className="eyebrow">{editingTutorialId ? '编辑教程' : '添加教程'}</p>
                <h2>{editingTutorialId ? '修改教程信息' : '填写教程信息'}</h2>
              </div>
              <button type="button" onClick={closeTutorialModal}>
                ×
              </button>
            </div>

            <label>
              B 站教程链接
              <div className="url-row">
                <input
                  value={url}
                  onChange={(event) => setUrl(event.target.value)}
                  placeholder="粘贴 B 站视频链接"
                />
                <button type="button" onClick={fetchBilibiliInfo} disabled={isFetchingVideoInfo}>
                  {isFetchingVideoInfo ? '获取中...' : '获取信息'}
                </button>
              </div>
              {videoInfoError && <p className="form-error">{videoInfoError}</p>}
            </label>

            <div className="form-grid">
              <label>
                视频标题
                <input
                  value={title}
                  onChange={(event) => setTitle(event.target.value)}
                  placeholder="自动获取或手动填写"
                />
              </label>

              <label>
                UP 主
                <input
                  value={author}
                  onChange={(event) => setAuthor(event.target.value)}
                  placeholder="自动获取或手动填写"
                />
              </label>

              <label>
                所属主题
                <select value={topicId} onChange={(event) => setTopicId(event.target.value)}>
                  {topics.map((topic) => (
                    <option key={topic.id} value={topic.id}>
                      {topic.name}
                    </option>
                  ))}
                </select>
              </label>

              <label>
                标签
                <input
                  value={tags}
                  onChange={(event) => setTags(event.target.value)}
                  placeholder="模型，插件，工作流"
                />
              </label>
            </div>

            <div className="modal-footer">
              <button type="button" className="ghost-button" onClick={closeTutorialModal}>
                取消
              </button>
              <button type="button" className="primary-button" onClick={addTutorial}>
                {editingTutorialId ? '保存修改' : '添加教程'}
              </button>
            </div>
          </section>
        </div>
      )}

      {showTopicModal && (
        <div className="modal-mask">
          <section className="modal topic-modal">
            <div className="modal-header">
              <div>
                <p className="eyebrow">{editingTopicId ? '管理主题' : '添加主题'}</p>
                <h2>{editingTopicId ? '修改主题信息' : '创建新的教程主题'}</h2>
              </div>
              <button type="button" onClick={closeTopicModal}>
                ×
              </button>
            </div>

            <label>
              主题名称
              <input
                value={topicName}
                onChange={(event) => setTopicName(event.target.value)}
                maxLength={TOPIC_NAME_MAX_LENGTH}
                placeholder="例如：人像写真"
              />
            </label>

            <label className="topic-description-field">
              主题描述
              <input
                value={topicDescription}
                onChange={(event) => setTopicDescription(event.target.value)}
                placeholder="例如：写真、人像、角色生成"
              />
            </label>

            {topicError && <p className="form-error">{topicError}</p>}

            <div className="modal-footer">
              {editingTopicId && (
                <button
                  type="button"
                  className="danger-button"
                  onClick={() => {
                    const topic = topics.find((item) => item.id === editingTopicId)
                    if (topic) {
                      deleteTopic(topic)
                    }
                  }}
                >
                  删除主题
                </button>
              )}

              <button type="button" className="ghost-button" onClick={closeTopicModal}>
                取消
              </button>
              <button type="button" className="primary-button" onClick={saveTopic}>
                {editingTopicId ? '保存主题' : '添加主题'}
              </button>
            </div>
          </section>
        </div>
      )}

      {showPathModal && (
        <div className="modal-mask">
          <section className="modal path-modal">
            <div className="modal-header">
              <div>
                <p className="eyebrow">资源扫描</p>
                <h2>添加本地资源路径</h2>
              </div>
              <button type="button" onClick={closePathModal}>
                ×
              </button>
            </div>

            <label>
              手动填写绝对路径
              <input
                value={scanPath}
                onChange={(event) => setScanPath(event.target.value)}
                placeholder="例如：D:\\AI绘画 或 /Users/name/AI绘画"
              />
            </label>

            <div className="folder-picker">
              <div>
                <strong>选择本地目录</strong>
                <span>
                  {scanPath
                    ? `当前选择：${scanPath}`
                    : '提交当前目录路径，不走网页上传，会由桌面端扫描真实文件。'}
                </span>
              </div>

              <button
                type="button"
                className="ghost-button folder-button"
                onClick={chooseDirectory}
                disabled={isSelectingDirectory || isScanningResources}
              >
                {isSelectingDirectory ? '选择中...' : '选择目录'}
              </button>
            </div>

            {scanError && <p className="form-error">{scanError}</p>}

            <div className="modal-footer">
              <button
                type="button"
                className="ghost-button"
                onClick={closePathModal}
                disabled={isScanningResources || isSelectingDirectory}
              >
                取消
              </button>
              <button
                type="button"
                className="primary-button"
                onClick={scanResources}
                disabled={isScanningResources || isSelectingDirectory}
              >
                {isScanningResources ? '扫描中...' : '扫描并添加'}
              </button>
            </div>
          </section>
        </div>
      )}

      {showFeedbackModal && (
        <div className="modal-mask">
          <section className="modal feedback-modal">
            <div className="modal-header">
              <div>
                <p className="eyebrow">反馈</p>
                <h2>联系我与提交反馈</h2>
              </div>
              <button
                type="button"
                onClick={() => {
                  setShowFeedbackModal(false)
                  setFeedbackError('')
                }}
              >
                ×
              </button>
            </div>

            <div className="feedback-qr-card">
              <img src="https://img.mooyan.me/img/2026/06/wechat.png" alt="微信二维码" />
            </div>

            <div className="feedback-contact-card">
              <strong>邮箱地址</strong>
              <span>mooyan214@gmail.com</span>
            </div>

            <label>
              反馈内容
              <textarea
                value={feedbackContent}
                onChange={(event) => setFeedbackContent(event.target.value)}
                placeholder="请填写你的建议、问题现象或使用反馈"
                rows={8}
              />
            </label>

            {feedbackError ? <p className="form-error">{feedbackError}</p> : null}

            <div className="modal-footer">
              <button
                type="button"
                className="ghost-button"
                onClick={() => {
                  setShowFeedbackModal(false)
                  setFeedbackError('')
                }}
                disabled={isSubmittingFeedback}
              >
                取消
              </button>
              <button
                type="button"
                className="primary-button"
                onClick={submitFeedback}
                disabled={isSubmittingFeedback}
              >
                {isSubmittingFeedback ? '提交中...' : '提交反馈'}
              </button>
            </div>
          </section>
        </div>
      )}

      {isGalleryPreviewOpen && selectedGalleryImage && (
        <div className="modal-mask gallery-lightbox-mask" onClick={() => setIsGalleryPreviewOpen(false)}>
          <section
            className="gallery-lightbox"
            onClick={(event) => {
              event.stopPropagation()
            }}
          >
            <div className="gallery-lightbox-header">
              <strong>{selectedGalleryImage.name}</strong>
                <button type="button" onClick={() => setIsGalleryPreviewOpen(false)}>
                ×
              </button>
            </div>

            <div
              className={`gallery-lightbox-body ${galleryZoom > 1 ? 'zoomed' : ''} ${
                isGalleryPreviewDragging ? 'dragging' : ''
              }`}
              onWheel={(event) => {
                event.preventDefault()
                setGalleryZoom((current) => {
                  const nextZoom = event.deltaY < 0 ? current + 0.12 : current - 0.12
                  const boundedZoom = Math.min(4, Math.max(0.5, Number(nextZoom.toFixed(2))))

                  if (boundedZoom < current) {
                    setGalleryPreviewOffset((offset) => {
                      if (boundedZoom <= 1.01 || current <= 1.01) {
                        return { x: 0, y: 0 }
                      }

                      const shrinkRatio = Math.max(0, (boundedZoom - 1) / (current - 1))
                      return {
                        x: Math.round(offset.x * shrinkRatio),
                        y: Math.round(offset.y * shrinkRatio),
                      }
                    })
                  }

                  return boundedZoom
                })
              }}
              onMouseDown={(event) => {
                if (galleryZoom <= 1.01) {
                  return
                }

                setIsGalleryPreviewDragging(true)
                setGalleryPreviewDragStart({ x: event.clientX, y: event.clientY })
              }}
              onMouseMove={(event) => {
                if (!isGalleryPreviewDragging) {
                  return
                }

                setGalleryPreviewOffset((current) => ({
                  x: current.x + (event.clientX - galleryPreviewDragStart.x),
                  y: current.y + (event.clientY - galleryPreviewDragStart.y),
                }))
                setGalleryPreviewDragStart({ x: event.clientX, y: event.clientY })
              }}
              onMouseUp={() => setIsGalleryPreviewDragging(false)}
              onMouseLeave={() => setIsGalleryPreviewDragging(false)}
            >
              <div
                className="gallery-transform-stage"
                style={{
                  transform: `translate(-50%, -50%) translate(${galleryPreviewOffset.x}px, ${galleryPreviewOffset.y}px)`,
                }}
              >
                <img
                  src={selectedGalleryImage.imageUrl || selectedGalleryImage.thumbnailUrl}
                  alt={selectedGalleryImage.name}
                  draggable={false}
                  onDragStart={(event) => event.preventDefault()}
                  style={{
                    transform: `scale(${galleryZoom})`,
                    transformOrigin: 'center center',
                  }}
                />
              </div>
            </div>
            <div className="gallery-lightbox-actions">
              <button type="button" className="ghost-button" onClick={revealCurrentGalleryImage}>
                从文件夹打开此图片
              </button>
              {selectedGalleryImage.prompt ? (
                <button type="button" className="ghost-button" onClick={copyCurrentPrompt}>
                  复制提示词
                </button>
              ) : null}
              <button type="button" className="danger-button" onClick={deleteGalleryImage}>
                删除图片
              </button>
            </div>
          </section>
        </div>
      )}

      {isGalleryCompareOpen && comparedGalleryImages.length >= 2 && (
        <div className="modal-mask gallery-lightbox-mask" onClick={() => setIsGalleryCompareOpen(false)}>
          <section
            className="gallery-lightbox gallery-compare-lightbox"
            onClick={(event) => {
              event.stopPropagation()
            }}
          >
            <div className="gallery-lightbox-header">
              <strong>图片对比</strong>
              <button type="button" onClick={() => setIsGalleryCompareOpen(false)}>
                ×
              </button>
            </div>

            <div className="gallery-compare-toolbar">
              <span>已选 {comparedGalleryImages.length} 张</span>
              <span>同步缩放 {Math.round(compareZoom * 100)}%</span>
            </div>

            <div
              className={`gallery-compare-grid compare-count-${comparedGalleryImages.length}`}
              onMouseDown={(event) => {
                if (
                  compareZoom <= 1.01 ||
                  event.target instanceof Element &&
                    (event.target.closest('.gallery-compare-card-header') || event.target.closest('button'))
                ) {
                  return
                }

                setIsCompareDragging(true)
                setCompareDragStart({ x: event.clientX, y: event.clientY })
              }}
              onMouseMove={(event) => {
                if (!isCompareDragging) {
                  return
                }

                setCompareOffset((current) => ({
                  x: current.x + (event.clientX - compareDragStart.x),
                  y: current.y + (event.clientY - compareDragStart.y),
                }))
                setCompareDragStart({ x: event.clientX, y: event.clientY })
              }}
              onMouseUp={() => setIsCompareDragging(false)}
              onMouseLeave={() => setIsCompareDragging(false)}
            >
              {comparedGalleryImages.map((image) => (
                <div key={image.id} className="gallery-compare-card">
                  <div className="gallery-compare-card-header">
                    <strong>{image.name}</strong>
                    <button
                      type="button"
                      className="gallery-compare-delete"
                      onClick={() => {
                        void deleteComparedGalleryImage(image.id)
                      }}
                    >
                      删除
                    </button>
                  </div>
                  <div
                    className={`gallery-compare-canvas ${compareZoom > 1 ? 'zoomed' : ''} ${
                      isCompareDragging ? 'dragging' : ''
                    }`}
                    onWheel={(event) => {
                      event.preventDefault()
                      setCompareZoom((current) => {
                        const nextZoom = event.deltaY < 0 ? current + 0.18 : current - 0.18
                        const boundedZoom = Math.min(6, Math.max(0.75, Number(nextZoom.toFixed(2))))

                        if (boundedZoom < current) {
                          setCompareOffset((offset) => {
                            if (boundedZoom <= 1.01 || current <= 1.01) {
                              return { x: 0, y: 0 }
                            }

                            const shrinkRatio = Math.max(0, (boundedZoom - 1) / (current - 1))
                            return {
                              x: Math.round(offset.x * shrinkRatio),
                              y: Math.round(offset.y * shrinkRatio),
                            }
                          })
                        }

                        return boundedZoom
                      })
                    }}
                    onMouseDown={(event) => {
                      if (compareZoom <= 1.01) {
                        return
                      }

                      setIsCompareDragging(true)
                      setCompareDragStart({ x: event.clientX, y: event.clientY })
                    }}
                  >
                    <div
                      className="gallery-transform-stage"
                      style={{
                        transform: `translate(-50%, -50%) translate(${compareOffset.x}px, ${compareOffset.y}px)`,
                      }}
                    >
                      <img
                        src={image.imageUrl || image.thumbnailUrl}
                        alt={image.name}
                        draggable={false}
                        onDragStart={(event) => event.preventDefault()}
                        style={{
                          transform: `scale(${compareZoom})`,
                          transformOrigin: 'center center',
                        }}
                      />
                    </div>
                  </div>
                </div>
              ))}
            </div>
          </section>
        </div>
      )}
    </main>
  )
}

export default App
