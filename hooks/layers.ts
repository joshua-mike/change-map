// Which files count as code, and which request-flow layer each one belongs to.

const CODE_EXTENSIONS = new Set([
  'cs', 'xaml', 'vb', 'fs', 'razor', 'cshtml',
  'ts', 'tsx', 'js', 'jsx', 'mjs', 'cjs', 'mts', 'cts',
  'py', 'ipynb', 'java', 'kt', 'go', 'rs', 'c', 'h', 'cpp', 'hpp', 'cc',
  'swift', 'rb', 'php', 'scala', 'lua', 'dart',
  'sql', 'ps1', 'psm1', 'sh', 'bash', 'css', 'scss', 'html', 'vue', 'svelte',
])

export function isCodeFile(path: string): boolean {
  const dot = path.lastIndexOf('.')
  const slash = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'))
  if (dot <= slash) return false
  return CODE_EXTENSIONS.has(path.slice(dot + 1).toLowerCase())
}

export type Layer = {
  name: string
  /** Position in the request path: a lower rank calls a higher rank. */
  rank: number
  pattern: RegExp
  /** A theme key, so the node dot follows the person's light or dark theme. */
  color: string
}

const DEFAULT_COLOR = 'subtle'

// Matched in list order, first hit wins. Patterns run against the lowercase
// relative path with forward slashes. `(^|\/)` anchors a folder name anywhere,
// which also covers worktree prefixes. Colors are theme keys chosen for
// contrast between neighbouring layers; their names (permission, planMode)
// mean nothing here.
export const BUILT_IN_LAYERS: readonly Layer[] = [
  { name: 'Test', rank: 0, pattern: /(^|\/)[^/]*(tests?|specs?|__tests__)\/|\.(test|spec)\.[a-z]+$|tests?\.[a-z]+$/, color: 'inactive' },
  {
    name: 'View',
    rank: 1,
    pattern: /\.(xaml|razor|cshtml|vue|svelte|html|css|scss)(\.[a-z]+)?$|(^|\/)(views?|pages|screens|components|ui|templates|layouts)\//,
    color: 'claude',
  },
  { name: 'Controller', rank: 2, pattern: /(^|\/)(controllers?|viewmodels?|presenters?)\//, color: 'permission' },
  { name: 'Service', rank: 3, pattern: /(^|\/)(services?|domain|domainlogic|logic|usecases?|application|business)\//, color: 'planMode' },
  { name: 'API client', rank: 4, pattern: /(^|\/)(clients?|proxies|proxy|sdk|gateways?)\//, color: 'ide' },
  { name: 'Server', rank: 5, pattern: /(^|\/)(server|api|routes?|endpoints?|handlers?|webapi|functions|lambdas?)\//, color: 'warning' },
  { name: 'Data access', rank: 6, pattern: /(^|\/)(repositor(y|ies)|datastores?|dataaccess|dal|persistence|data)\//, color: 'suggestion' },
  { name: 'Model', rank: 7, pattern: /(^|\/)(models?|entities|dtos?|schemas?|types)\//, color: 'remember' },
  { name: 'Database', rank: 8, pattern: /\.sql$|(^|\/)(db|database|migrations?|sql)\//, color: 'error' },
  { name: 'Shared', rank: 9, pattern: /(^|\/)(shared|common|libs?|utils?|helpers|core|infrastructure)\//, color: DEFAULT_COLOR },
]

/** The layer of a file no pattern matches: its place in the rows comes from its edges, or it goes last. */
export const OTHER_LAYER: Layer = { name: 'Other', rank: 10, pattern: /$^/, color: DEFAULT_COLOR }

/** A layer as `layers.local.json` writes it: `pattern` is a regular expression source. */
export type LayerConfig = {
  name: string
  rank: number
  pattern: string
  color?: string
}

// The local layers first, so a project's own pattern wins over a built-in one.
let layers: readonly Layer[] = BUILT_IN_LAYERS

/**
 * Takes the layers of a `layers.local.json`, which match before the built-in
 * ones. Returns what is wrong with the file, or undefined when it was taken.
 * A wrong file leaves the built-in layers alone.
 */
export function useLocalLayers(configs: unknown): string | undefined {
  if (!Array.isArray(configs)) return 'must be a JSON array of layers'
  const local: Layer[] = []
  for (const [index, config] of configs.entries()) {
    const problem = toLayer(config)
    if (typeof problem === 'string') return `layer ${index + 1}: ${problem}`
    local.push(problem)
  }
  layers = [...local, ...BUILT_IN_LAYERS]
  return undefined
}

function toLayer(config: unknown): Layer | string {
  if (typeof config !== 'object' || config === null) return 'must be an object'
  const { name, rank, pattern, color } = config as Record<string, unknown>
  if (typeof name !== 'string' || name === '') return 'needs a name'
  if (typeof rank !== 'number' || !Number.isFinite(rank)) return `${name}: rank must be a number`
  if (typeof pattern !== 'string') return `${name}: pattern must be a regular expression source`
  if (color !== undefined && typeof color !== 'string') return `${name}: color must be a theme key`
  try {
    return { name, rank, pattern: new RegExp(pattern, 'i'), color: color ?? DEFAULT_COLOR }
  } catch (error) {
    return `${name}: ${error instanceof Error ? error.message : 'bad pattern'}`
  }
}

export function layerOf(relPath: string): Layer {
  const path = relPath.toLowerCase()
  return layers.find(layer => layer.pattern.test(path)) ?? OTHER_LAYER
}
