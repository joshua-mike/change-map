import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, UiPressArgument } from 'claude-code'

import type { ChangedFile, LineRange } from '../types'
import { listWorktrees, pollChanges, repoRootOf, takeBaseline, type GitBaseline, type PolledChange } from './gitChanges'
import { isCodeFile, useLocalLayers } from './layers'
import { editRange, formatRanges, mergeRanges } from './lineRanges'
import { buildRows, fileNameOf, fitEnd, fitStart, type MapRow } from './map'
import { EMPTY_SCAN, scanSymbols, type SymbolScan } from './symbols'

const PANE = 'change-map'
const TITLE = 'Change map'
const NEW_LABEL = 'new'
const LOCAL_LAYERS_FILE = 'layers.local.json'

// Tools that can write a file. A call of one, in the main loop or a subagent,
// starts a git poll. Read-only tools start none, so they cost nothing.
const WRITING_TOOLS = new Set<string>(['Edit', 'Write', 'NotebookEdit', 'Bash', 'PowerShell'])

// Below this many columns the changed lines move under the file name.
const TWO_COLUMN_MIN_LINES_ROOM = 12
const MAX_NAME_WIDTH = 40

// Change the shape tag when ChangedFile changes: a reload keeps what the old code stored.
const files = atom({ plugin: 'change-map', key: 'files' } as const, [], { shape: 'files-4' })

// Cache only: keyed by path and edit count, so a stale entry is never read.
// A reload empties it and the next draw reads the files again.
const scanCache = new Map<string, SymbolScan>()

// The session's project root. `session.start` gives the first value, and
// syncWorkingDirectory reads it again on each event that can list a file.
let workingDirectory: string | undefined

// The repositories and worktrees polled for changes, by lowercase root. A
// reload empties it and takes new baselines; files already listed stay listed.
const baselines = new Map<string, GitBaseline>()

// One poll at a time: a request during a poll runs one more poll after it,
// so each baseline's head moves in order and no change is missed.
let runningPoll: Promise<void> | undefined
let isPollRequested = false

function toForwardSlashes(path: string): string {
  return path.replace(/\\/g, '/')
}

// Windows paths are case-insensitive.
function pathKey(path: string): string {
  return toForwardSlashes(path).replace(/\/+$/, '').toLowerCase()
}

function parentOf(path: string): string {
  return path.slice(0, Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\')))
}

function insideWorkingDirectory(absPath: string): boolean {
  if (workingDirectory === undefined) return false
  return pathKey(absPath).startsWith(`${pathKey(workingDirectory)}/`)
}

function relativePath(absPath: string): string {
  const path = toForwardSlashes(absPath)
  if (workingDirectory === undefined || !insideWorkingDirectory(path)) return path
  return path.slice(toForwardSlashes(workingDirectory).replace(/\/+$/, '').length + 1)
}

/** A root inside the working directory, or one that holds it: its files can be listed. */
function isRelevantRoot(root: string): boolean {
  if (workingDirectory === undefined) return false
  const dir = pathKey(workingDirectory)
  const key = pathKey(root)
  return key === dir || key.startsWith(`${dir}/`) || dir.startsWith(`${key}/`)
}

function isUnderKnownRoot(absPath: string): boolean {
  const key = pathKey(absPath)
  for (const baseline of baselines.values()) if (key.startsWith(`${pathKey(baseline.root)}/`)) return true
  return false
}

async function addRepository($: EngineInterface, root: string): Promise<void> {
  if (baselines.has(pathKey(root)) || !isRelevantRoot(root)) return
  baselines.set(pathKey(root), await takeBaseline($, root))
}

/**
 * Adds the repository that holds `dir`, when there is one, then every worktree
 * of each known repository. A session often works in a worktree nested inside
 * its directory, and the main checkout's git never sees that worktree's files.
 */
async function discoverRepositories($: EngineInterface, dir?: string): Promise<void> {
  if (dir !== undefined) {
    const root = await repoRootOf($, dir)
    if (root !== undefined) await addRepository($, root)
  }
  const listed = new Set<string>()
  for (const baseline of [...baselines.values()]) {
    if (listed.has(pathKey(baseline.root))) continue
    for (const root of await listWorktrees($, baseline.root)) {
      listed.add(pathKey(root))
      await addRepository($, root)
    }
  }
}

/**
 * Reads the session's project root again and, when it moved, polls the
 * repositories of the new root from a fresh baseline. The desktop app starts
 * some sessions in a spare folder and moves them to the project later, after
 * `session.start` ran, so the first value can be stale. The root, not the
 * cwd: a shell `cd` into a subfolder does not move it.
 */
async function syncWorkingDirectory($: EngineInterface): Promise<void> {
  const root = await $.session.root()
  if (workingDirectory !== undefined && pathKey(root) === pathKey(workingDirectory)) return
  workingDirectory = root
  baselines.clear()
  await discoverRepositories($, root).catch(() => undefined)
}

/**
 * Takes the project's own layers from `layers.local.json` beside the plugin
 * manifest, when the file is there and holds something. A bad file is reported
 * once and leaves the built-in layers in place.
 */
async function loadLocalLayers($: EngineInterface): Promise<void> {
  const path = `${$.plugin.root}/${LOCAL_LAYERS_FILE}`
  if (!(await $.fs.exists(path).catch(() => false))) return
  const text = await $.fs.read(path).catch(() => '')
  if (text.trim() === '') return
  let problem: string | undefined
  try {
    problem = useLocalLayers(JSON.parse(text))
  } catch (error) {
    problem = error instanceof Error ? error.message : 'is not JSON'
  }
  if (problem !== undefined) $.ui.toast(`${LOCAL_LAYERS_FILE}: ${problem}`)
}

async function scanFile($: EngineInterface, file: ChangedFile): Promise<SymbolScan> {
  const cacheKey = `${file.key}#${file.edits}`
  const cached = scanCache.get(cacheKey)
  if (cached !== undefined) return cached
  // A deleted or oversized file still lists; it only has no edges.
  const scan = await $.fs.read(file.absPath).then(scanSymbols, () => EMPTY_SCAN)
  // Each poll moves the edit count, so drop the file's older entries.
  for (const staleKey of scanCache.keys()) if (staleKey.startsWith(`${file.key}#`)) scanCache.delete(staleKey)
  scanCache.set(cacheKey, scan)
  return scan
}

/**
 * Adds each code file once, in the order given. A file already listed counts
 * one more edit, so its symbols are read again at the next draw. Whether the
 * file is new is kept from the first listing. Its changed lines come from the
 * diff when there is one, which replaces what the tools reported; outside git
 * the lines each Edit reports are joined.
 */
async function recordChanges($: EngineInterface, changes: readonly PolledChange[]): Promise<void> {
  const byKey = new Map<string, PolledChange>()
  for (const change of changes) {
    if (!isCodeFile(change.absPath) || !insideWorkingDirectory(change.absPath)) continue
    const key = pathKey(change.absPath)
    const known = byKey.get(key)
    if (known === undefined) byKey.set(key, change)
    else if (change.isNew && !known.isNew) byKey.set(key, { ...known, isNew: true })
  }
  if (byKey.size === 0) return

  let isFirstFile = false
  await update($, files, list => {
    // `update` reruns this on a version conflict, so reset what it decides.
    isFirstFile = false
    let next = list
    for (const [key, change] of byKey) {
      if (next.some(file => file.key === key)) {
        next = next.map(file => {
          if (file.key !== key) return file
          const ranges = file.isNew ? [] : change.isFromDiff ? change.ranges : mergeRanges([...file.ranges, ...change.ranges])
          return { ...file, edits: file.edits + 1, ranges }
        })
        continue
      }
      if (next.length === 0) isFirstFile = true
      next = [
        ...next,
        {
          key,
          absPath: change.absPath,
          relPath: relativePath(change.absPath),
          order: next.length + 1,
          edits: 1,
          isNew: change.isNew,
          ranges: change.isNew ? [] : mergeRanges(change.ranges),
        },
      ]
    }
    return next
  })
  if (isFirstFile) void $.ui.open({ id: PANE, title: TITLE })
}

/**
 * Removes each file the session created that is gone from disk, then numbers
 * the remaining rows again in their first-change order. A created file that a
 * later command deletes is no change, such as a folder that a command moves
 * aside and removes. A deleted file that existed before the session stays.
 */
async function pruneVanishedFiles($: EngineInterface): Promise<void> {
  const created = (await read($, files)).filter(file => file.isNew)
  // A failed check keeps the file: a missed removal is safer than a lost row.
  const isGone = await Promise.all(created.map(file => $.fs.exists(file.absPath).then(exists => !exists, () => false)))
  // The edit count at the check. A tool call outside the poll can recreate the
  // file before the update runs; its new edit count keeps the row.
  const vanished = new Map<string, number>()
  created.forEach((file, index) => {
    if (isGone[index]) vanished.set(file.key, file.edits)
  })
  if (vanished.size === 0) return

  await update($, files, list =>
    list
      .filter(file => vanished.get(file.key) !== file.edits)
      .sort((a, b) => a.order - b.order)
      .map((file, index) => ({ ...file, order: index + 1 })),
  )
  for (const cacheKey of scanCache.keys()) {
    if (vanished.has(cacheKey.slice(0, cacheKey.lastIndexOf('#')))) scanCache.delete(cacheKey)
  }
}

function requestPoll($: EngineInterface): Promise<void> {
  if (runningPoll !== undefined) {
    isPollRequested = true
    return runningPoll
  }
  runningPoll = (async () => {
    do {
      isPollRequested = false
      await discoverRepositories($)
      // A poll cannot tell a new edit from an old dirty state, so each file it
      // finds is marked edited and its symbols are read again at the next draw.
      for (const baseline of [...baselines.values()]) await recordChanges($, await pollChanges($, baseline))
      await pruneVanishedFiles($)
    } while (isPollRequested)
  })().finally(() => {
    runningPoll = undefined
  })
  return runningPoll
}

/**
 * The lines an Edit call changed, from the text it wrote. A Write or a
 * NotebookEdit reports none: the diff gives a Write's lines, and a notebook
 * cell has no line number.
 */
async function rangesOfToolCall($: EngineInterface, call: { tool: string; new_string?: string }, path: string): Promise<LineRange[]> {
  if (call.tool !== 'Edit') return []
  const range = await $.fs.read(path).then(content => editRange(content, call.new_string), () => undefined)
  return range === undefined ? [] : [range]
}

async function copyFileName($: EngineInterface, name: string, press: UiPressArgument): Promise<void> {
  const copied = await $.ui.copy({ text: name, surface: press.surface })
  $.ui.toast(copied.isCopied ? `Copied ${name}` : `Could not copy ${name}: ${copied.reason}`)
}

function linesLabel(file: ChangedFile): string {
  return file.isNew ? NEW_LABEL : formatRanges(file.ranges)
}

/** Column widths shared by every row, so the columns line up. */
function measure(rows: readonly MapRow[], columns: number) {
  const laneWidth = Math.max(...rows.map(row => row.laneBefore.length + 1 + row.laneAfter.length))
  const orderWidth = String(rows.length).length
  const nameWidth = Math.min(MAX_NAME_WIDTH, Math.max(...rows.map(row => fileNameOf(row.file.relPath).length)))
  const editsWidth = Math.max(0, ...rows.map(row => (row.file.edits > 1 ? `×${row.file.edits}`.length + 1 : 0)))
  const linesWidth = Math.max(...rows.map(row => linesLabel(row.file).length))
  const leftWidth = laneWidth + 1 + orderWidth + 1 + nameWidth + editsWidth
  const linesRoom = columns - leftWidth - 2
  const isTwoColumn = linesRoom >= Math.min(linesWidth, TWO_COLUMN_MIN_LINES_ROOM)
  return { laneWidth, orderWidth, nameWidth, linesRoom, isTwoColumn }
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    workingDirectory = e.cwd
    await $.command.register({
      name: 'change-map',
      description: 'Show the map of code files changed in this session',
    })
    await loadLocalLayers($)
    // Without a repository the map still lists Edit and Write calls.
    await discoverRepositories($, e.cwd).catch(() => undefined)
    // After a reload the list survives; put the pane back if it has content.
    if ((await read($, files)).length > 0) void $.ui.open({ id: PANE, title: TITLE })
    return next(e)
  })

  on('command.run', { command: 'change-map' }, async $ => {
    await $.ui.open({ id: PANE, title: TITLE })
    return { text: 'Change map opened.' }
  })

  on('session.end', async ($, e, next) => {
    if (e.reason === 'clear') {
      await update($, files, () => [])
      baselines.clear()
      if (workingDirectory !== undefined) await discoverRepositories($, workingDirectory).catch(() => undefined)
    }
    return next(e)
  })

  on('tool.call', async ($, e, next) => {
    const path =
      e.tool === 'Edit' || e.tool === 'Write' ? e.file_path : e.tool === 'NotebookEdit' ? e.notebook_path : undefined
    // A Write creates a file that is not there yet, so look before the tool runs.
    const isNew = e.tool === 'Write' && path !== undefined && !(await $.fs.exists(path).catch(() => true))

    const ran = await next(e)
    if (!WRITING_TOOLS.has(e.tool) || ran.deny !== undefined) return ran
    await syncWorkingDirectory($)

    // The tool's own path lists the file at once, also outside a git repository.
    if (path !== undefined && ran.isError !== true) {
      const ranges = isNew ? [] : await rangesOfToolCall($, e, path)
      await recordChanges($, [{ absPath: path, isNew, ranges, isFromDiff: false }])
      // A file in a repository no baseline covers yet: a later shell edit of it must be found too.
      if (insideWorkingDirectory(path) && !isUnderKnownRoot(path)) await discoverRepositories($, parentOf(path))
    }

    // A failed shell command can still have changed files, so poll after it too.
    await requestPoll($)
    return ran
  }).catch(($, e, next) => next(e)) // A map fault must never refuse a tool: replay or run it.

  // A background command or an MCP tool can write after its call returned.
  on('turn.complete', async ($, e, next) => {
    const answer = await next(e)
    await syncWorkingDirectory($)
    await requestPoll($)
    return answer
  }).catch(($, e, next) => next(e))

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text, Button } = $.ui.resolve(e)
    const list = await read($, files)
    if (list.length === 0) return <Text dimColor>No code files changed yet.</Text>

    const scans = await Promise.all(list.map(file => scanFile($, file)))
    const rows = buildRows(list, scans)
    const widths = measure(rows, e.props.bodyColumns)
    const count = list.length === 1 ? '1 code file' : `${list.length} code files`

    const drawLines = (row: MapRow, room: number) => {
      if (row.file.isNew) return <Text mono color="success">{NEW_LABEL}</Text>
      const label = linesLabel(row.file)
      return <Text mono dimColor tabular>{fitStart(label, Math.max(4, room))}</Text>
    }

    const drawRow = (row: MapRow) => {
      const name = fileNameOf(row.file.relPath)
      const shownName = fitEnd(name, widths.nameWidth).padEnd(widths.nameWidth)
      const edits = row.file.edits > 1 ? ` ×${row.file.edits}` : ''
      const rowKey = `row:${row.file.key}`
      const indent = ' '.repeat(widths.orderWidth + 2)
      return (
        <Box key={rowKey} flexDirection="column">
          <Box flexDirection="row" justifyContent="space-between" gap={2}>
            <Box flexDirection="row" flexShrink={0}>
              <Text mono>
                <Text dimColor>{row.laneBefore}</Text>
                <Text color={row.layer.color}>●</Text>
                <Text dimColor>{`${row.laneAfter} ${String(row.file.order).padStart(widths.orderWidth)} `}</Text>
              </Text>
              <Button key={`file:${row.file.key}`} plain hover={{ underline: true }} onPress={press => void copyFileName($, name, press)}>
                <Text mono weight="semibold">{shownName}</Text>
                <Text mono dimColor>{edits}</Text>
              </Button>
            </Box>
            {widths.isTwoColumn && <Box flexShrink={0}>{drawLines(row, widths.linesRoom)}</Box>}
          </Box>
          {!widths.isTwoColumn && (
            <Box flexDirection="row">
              <Text mono dimColor>{`${row.laneBelow}${indent}`}</Text>
              {drawLines(row, e.props.bodyColumns - widths.laneWidth - indent.length - 1)}
            </Box>
          )}
        </Box>
      )
    }

    return (
      <Box flexDirection="column">
        <Box flexDirection="row" justifyContent="space-between" gap={2}>
          <Text weight="semibold" dimColor>{'CHANGE MAP'}</Text>
          <Text dimColor>{`${count} · request flows down`}</Text>
        </Box>
        <Box flexDirection="column" marginY={1}>{rows.map(drawRow)}</Box>
        <Text dimColor>{'Click a file to copy its name. Right: the lines the session changed, or new for a file it created.'}</Text>
        <Text dimColor>{'An edge joins two files when one names a type or method that the other declares.'}</Text>
      </Box>
    )
  })
}
