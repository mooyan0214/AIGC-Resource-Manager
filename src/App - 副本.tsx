import { useEffect, useMemo, useRef, useState } from 'react'
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

type PersistedAppData = {
  tutorials?: Tutorial[]
}
type DesktopResourceApi = {
  selectDirectory?: () => Promise<string | null>
  scanDirectory?: (path: string) => Promise<ResourceNode[] | ScannedResourceItem[]>
  load?: () => Promise<PersistedAppData | null>
  save?: (data: { tutorials: Tutorial[] }) => Promise<{ success: boolean; filePath?: string }>
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

const topics: Topic[] = [
  { id: 'basics', name: '入门基础', description: 'ComfyUI 基础使用与安装' },
  { id: 'portrait', name: '人像写真', description: '写真、人像、角色生成' },
  { id: 'workflow', name: '工作流实战', description: '完整工作流拆解复用' },
  { id: 'plugins', name: '插件节点', description: '自定义节点与插件管理' },
  { id: 'prompt', name: '提示词库', description: '提示词分类与复用' },
]

const createEmptyResources = (): ResourceNode[] => []

const normalizePath = (path: string) => path.replace(/\\/g, '/')

const getPathName = (path: string) => {
  const parts = normalizePath(path).split('/').filter(Boolean)
  return parts.at(-1) || path
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
  const rootName = getPathName(scanRootPath)

  const rootNode: ResourceNode = {
    id: scanRootPath,
    name: rootName,
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

  return sortResourceNodes(nodes)
}

const isResourceNodeArray = (
  items: ResourceNode[] | ScannedResourceItem[],
): items is ResourceNode[] => {
  return items.every((item) => 'children' in item || item.type === 'file')
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
const saveResourcesByDesktopApi = async (tutorials: Tutorial[]) => {
  if (window.resourceApi?.save) {
    return window.resourceApi.save({ tutorials })
  }
  if (window.localModels?.save) {
    return window.localModels.save({ tutorials })
  }
  return null
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

const ResourceTree = ({
  nodes,
  expandedIds,
  onToggle,
  level = 0,
}: {
  nodes: ResourceNode[]
  expandedIds: string[]
  onToggle: (id: string) => void
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

        return (
          <div
            key={node.id}
            className={`resource-node level-${level} ${isLast ? 'last' : ''}`}
            style={{ '--tree-level': level } as React.CSSProperties}
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
              <span className={`tree-branch ${isLast ? 'last' : ''}`}>
                {level === 0 ? '●' : isLast ? '└' : '├'}
              </span>

              <span className={`folder-chevron ${isExpanded ? 'expanded' : ''}`}>
                {isFolder && hasChildren ? '›' : ''}
              </span>

              <span className="resource-icon">
                {isFolder ? (isExpanded ? '📂' : '📁') : '📄'}
              </span>

              <div className="resource-node-main">
                <strong>{node.name}</strong>
                <small>{node.path}</small>
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
                level={level + 1}
              />
            )}
          </div>
        )
      })}
    </div>
  )
}

const initialTutorials: Tutorial[] = [
  {
    id: 'tutorial-1',
    title: 'ComfyUI 基础工作流入门',
    author: '示例 UP 主',
    url: 'https://www.bilibili.com/video/BVxxxx',
    topicId: 'basics',
    tags: ['Checkpoint', 'VAE', '工作流'],
    resourcePath: '',
    resources: createEmptyResources(),
  },
  {
    id: 'tutorial-2',
    title: '自定义节点安装与管理',
    author: '示例 UP 主',
    url: 'https://www.bilibili.com/video/BVyyyy',
    topicId: 'plugins',
    tags: ['插件', '自定义节点'],
    resourcePath: '',
    resources: createEmptyResources(),
  },
]

function App() {
  const hasLoadedSavedData = useRef(false)
  const [tutorials, setTutorials] = useState<Tutorial[]>(initialTutorials)
  const [selectedTopicId, setSelectedTopicId] = useState(topics[0].id)
  const [expandedTopicIds, setExpandedTopicIds] = useState<string[]>([topics[0].id])
  const [selectedTutorialId, setSelectedTutorialId] = useState<string | null>(initialTutorials[0].id)
  const [showAddModal, setShowAddModal] = useState(false)
  const [pendingDeleteTutorialId, setPendingDeleteTutorialId] = useState<string | null>(null)

  const [url, setUrl] = useState('')
  const [title, setTitle] = useState('')
  const [author, setAuthor] = useState('')
  const [topicId, setTopicId] = useState(topics[0].id)
  const [tags, setTags] = useState('')
  const [isFetchingVideoInfo, setIsFetchingVideoInfo] = useState(false)
  const [videoInfoError, setVideoInfoError] = useState('')
  const [editingTutorialId, setEditingTutorialId] = useState<string | null>(null)

  const [showPathModal, setShowPathModal] = useState(false)
  const [scanPath, setScanPath] = useState('')
  const [scanError, setScanError] = useState('')
  const [isSelectingDirectory, setIsSelectingDirectory] = useState(false)
  const [isScanningResources, setIsScanningResources] = useState(false)
  const [expandedResourceNodeIds, setExpandedResourceNodeIds] = useState<string[]>([])

  const selectedTutorial = tutorials.find((tutorial) => tutorial.id === selectedTutorialId)
  const currentTopic = topics.find((topic) => topic.id === selectedTopicId)
  const pendingDeleteTutorial = tutorials.find((tutorial) => tutorial.id === pendingDeleteTutorialId)
  useEffect(() => {
  loadResourcesByDesktopApi()
    .then((savedData) => {
      if (savedData?.tutorials && savedData.tutorials.length > 0) {
        setTutorials(savedData.tutorials)
        const firstTutorial = savedData.tutorials[0]
        setSelectedTopicId(firstTutorial.topicId)
        setSelectedTutorialId(firstTutorial.id)
        setExpandedTopicIds((current) =>
          current.includes(firstTutorial.topicId) ? current : [...current, firstTutorial.topicId],
        )
      }
    })
    .finally(() => {
      hasLoadedSavedData.current = true
    })
}, [])
useEffect(() => {
  if (!hasLoadedSavedData.current) {
    return
  }
  saveResourcesByDesktopApi(tutorials).catch((error) => {
    console.error('保存教程数据失败', error)
  })
}, [tutorials])

  const filteredTutorials = useMemo(() => {
    return tutorials.filter((tutorial) => tutorial.topicId === selectedTopicId)
  }, [tutorials, selectedTopicId])

  const totalResources = tutorials.reduce((total, tutorial) => {
    return total + countResourceFiles(tutorial.resources)
  }, 0)

  const toggleTopic = (id: string) => {
    setSelectedTopicId(id)
    setExpandedTopicIds((current) =>
      current.includes(id) ? current.filter((topicId) => topicId !== id) : [...current, id],
    )
  }

  const mockFetchBilibiliInfo = async () => {
    const inputUrl = url.trim()

    if (!inputUrl) {
      setVideoInfoError('请先粘贴 B 站教程链接')
      return
    }

    const bvMatch = inputUrl.match(/BV[a-zA-Z0-9]+/)
    const avMatch = inputUrl.match(/av(\d+)/i)

    if (!bvMatch && !avMatch) {
      setVideoInfoError('没有识别到 BV 号或 AV 号，请检查链接')
      return
    }

    const query = bvMatch ? `bvid=${bvMatch[0]}` : `aid=${avMatch?.[1]}`

    try {
      setIsFetchingVideoInfo(true)
      setVideoInfoError('')

      const response = await fetch(`/bilibili-api/x/web-interface/view?${query}`)

      if (!response.ok) {
        throw new Error('请求失败')
      }

      const result = await response.json()

      if (result.code !== 0 || !result.data) {
        throw new Error(result.message || '获取视频信息失败')
      }

      setTitle(result.data.title || '')
      setAuthor(result.data.owner?.name || '')
    } catch {
      setVideoInfoError('获取失败：请确认链接正确，或稍后再试')
    } finally {
      setIsFetchingVideoInfo(false)
    }
  }

  const resetForm = () => {
    setUrl('')
    setTitle('')
    setAuthor('')
    setTopicId(topics[0].id)
    setTags('')
    setVideoInfoError('')
    setEditingTutorialId(null)
  }

  const openAddTutorialModal = () => {
    resetForm()
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

    const tutorialData = {
      title: title.trim(),
      author: author.trim() || '未知 UP 主',
      url: url.trim(),
      topicId,
      tags: tags
        .split(/[，,]/)
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

      setSelectedTopicId(topicId)
      setSelectedTutorialId(editingTutorialId)
      setExpandedTopicIds((current) => (current.includes(topicId) ? current : [...current, topicId]))
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
    setSelectedTopicId(topicId)
    setSelectedTutorialId(tutorial.id)
    setExpandedTopicIds((current) => (current.includes(topicId) ? current : [...current, topicId]))
    setShowAddModal(false)
    resetForm()
  }

  const deleteTutorial = (id: string) => {
    setPendingDeleteTutorialId(id)
  }

  const confirmDeleteTutorial = () => {
    if (!pendingDeleteTutorialId) {
      return
    }

    setTutorials((current) => current.filter((item) => item.id !== pendingDeleteTutorialId))

    if (selectedTutorialId === pendingDeleteTutorialId) {
      setSelectedTutorialId(null)
    }

    if (editingTutorialId === pendingDeleteTutorialId) {
      resetForm()
      setShowAddModal(false)
    }

    setPendingDeleteTutorialId(null)
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

  const toggleResourceNode = (id: string) => {
    setExpandedResourceNodeIds((current) =>
      current.includes(id) ? current.filter((nodeId) => nodeId !== id) : [...current, id],
    )
  }

  return (
    <main className="app-shell">
      <aside className="side-nav">
        <div className="brand">
          <div className="brand-logo">教程</div>
          <div>
            <strong>资源管理器</strong>
            <span>ComfyUI 教程库</span>
          </div>
        </div>

        <div className="topic-panel">
          <div className="panel-title">教程主题</div>

          {topics.map((topic) => {
            const topicTutorials = tutorials.filter((tutorial) => tutorial.topicId === topic.id)
            const expanded = expandedTopicIds.includes(topic.id)

            return (
              <div key={topic.id} className="topic-group">
                <button
                  type="button"
                  className={`topic-button ${selectedTopicId === topic.id ? 'active' : ''}`}
                  onClick={() => toggleTopic(topic.id)}
                >
                  <span>
                    <strong>{topic.name}</strong>
                    <small>{topic.description}</small>
                  </span>
                  <b>{expanded ? '−' : '+'}</b>
                </button>

                {expanded && (
                  <div className="topic-children">
                    {topicTutorials.length === 0 ? (
                      <p>暂无教程</p>
                    ) : (
                      topicTutorials.map((tutorial) => (
                        <button
                          type="button"
                          key={tutorial.id}
                          className={selectedTutorialId === tutorial.id ? 'active' : ''}
                          onClick={() => {
  setSelectedTopicId(tutorial.topicId)
  setSelectedTutorialId(tutorial.id)
}}
                        >
                          {tutorial.title}
                        </button>
                      ))
                    )}
                  </div>
                )}
              </div>
            )
          })}
        </div>
      </aside>

      <section className="main-view">
        <header className="top-bar">
          <div>
            <p className="eyebrow">教程资源中心</p>
            <h1>ComfyUI 教程资源管理器</h1>
            <span>添加 B 站教程后，在详情页关联模型、工作流、插件和提示词。</span>
          </div>

          <button type="button" className="primary-button" onClick={openAddTutorialModal}>
            + 添加教程
          </button>
        </header>

        <section className="stats">
          <article>
            <span>教程主题</span>
            <strong>{topics.length}</strong>
          </article>
          <article>
            <span>教程数量</span>
            <strong>{tutorials.length}</strong>
          </article>
          <article>
            <span>已扫描文件</span>
            <strong>{totalResources}</strong>
          </article>
        </section>

        <section className="content-grid">
          <article className="tutorial-section">
            <div className="section-header">
              <div>
                <p className="eyebrow">教程列表</p>
                <h2>{currentTopic?.name}</h2>
              </div>
              <span>{filteredTutorials.length} 个教程</span>
            </div>

            <div className="tutorial-grid">
              {filteredTutorials.map((tutorial) => {
                const resourceCount = countResourceFiles(tutorial.resources)

                return (
                  <button
                    type="button"
                    key={tutorial.id}
                    className={`tutorial-card ${
                      selectedTutorialId === tutorial.id ? 'active' : ''
                    }`}
                    onClick={() => {
  setSelectedTopicId(topic.id)
  setSelectedTutorialId(tutorial.id)
}}
                  >
                    <span className="card-glow" />
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

                    <div className="card-actions">
                      <span>查看详情</span>
                      <div>
                        <em
                          onClick={(event) => {
                            event.stopPropagation()
                            editTutorial(tutorial)
                          }}
                        >
                          编辑
                        </em>
                        <em
                          onClick={(event) => {
                            event.stopPropagation()
                            deleteTutorial(tutorial.id)
                          }}
                        >
                          删除
                        </em>
                      </div>
                    </div>
                  </button>
                )
              })}

              {filteredTutorials.length === 0 && (
                <div className="empty-state">当前主题还没有教程，点击右上角添加。</div>
              )}
            </div>
          </article>

          <article className="detail-section">
            {selectedTutorial ? (
              <>
                <div className="detail-header">
                  <div>
                    <p className="eyebrow">教程详情</p>
                    <h2>{selectedTutorial.title}</h2>
                    <span>
                      UP 主：{selectedTutorial.author} · 主题：
                      {topics.find((topic) => topic.id === selectedTutorial.topicId)?.name}
                    </span>
                  </div>

                  <div className="detail-actions">
                    <a href={selectedTutorial.url} target="_blank" rel="noreferrer">
                      打开 B 站
                    </a>
                  </div>
                </div>

                <div className="tag-row detail-tags">
                  {selectedTutorial.tags.map((tag) => (
                    <i key={tag}>{tag}</i>
                  ))}
                </div>

                <div className="resource-title">
                  <div>
                    <h3>本地资源</h3>
                    <p>
                      {selectedTutorial.resourcePath
                        ? `当前路径：${selectedTutorial.resourcePath}`
                        : '手动填写绝对路径，或选择本地目录后扫描资源。'}
                    </p>
                  </div>

                  <button type="button" className="primary-button small" onClick={openPathModal}>
                    添加路径并扫描
                  </button>
                </div>

                <ResourceTree
                  nodes={selectedTutorial.resources}
                  expandedIds={expandedResourceNodeIds}
                  onToggle={toggleResourceNode}
                />
              </>
            ) : (
              <div className="empty-detail">请选择一个教程查看详情</div>
            )}
          </article>
        </section>
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
                <button
                  type="button"
                  onClick={mockFetchBilibiliInfo}
                  disabled={isFetchingVideoInfo}
                >
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
                placeholder="例如：D:\ComfyUI 或 /Users/name/ComfyUI"
              />
            </label>

            <div className="folder-picker">
              <div>
                <strong>选择本地目录</strong>
                <span>
                  {scanPath
                    ? `当前选择：${scanPath}`
                    : '提交当前目录路径，不走网页上传，会由桌面端扫描真实文件'}
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

      {pendingDeleteTutorial && (
        <div className="modal-mask">
          <section className="modal delete-modal">
            <div className="modal-header">
              <div>
                <p className="eyebrow">删除教程</p>
                <h2>确认删除？</h2>
              </div>
              <button type="button" onClick={() => setPendingDeleteTutorialId(null)}>
                ×
              </button>
            </div>

            <p className="delete-message">
              确定要删除「{pendingDeleteTutorial.title}」吗？删除后会从教程列表中移除。
            </p>

            <div className="modal-footer">
              <button
                type="button"
                className="ghost-button"
                onClick={() => setPendingDeleteTutorialId(null)}
              >
                取消
              </button>
              <button type="button" className="danger-button" onClick={confirmDeleteTutorial}>
                确认删除
              </button>
            </div>
          </section>
        </div>
      )}
    </main>
  )
}

export default App