// Turns the changed-file list into the rows of the code map: one per file,
// with its graph lane, its layer, and its changed lines.

import type { ChangedFile } from '../types'
import { drawLanes } from './dag'
import { layerOf, OTHER_LAYER, type Layer } from './layers'
import { EMPTY_SCAN, references, type SymbolScan } from './symbols'

const ELLIPSIS = '…'
const NODE = '●'

export type MapRow = {
  file: ChangedFile
  layer: Layer
  /** The lane cells left of the node glyph. */
  laneBefore: string
  /** The lane cells right of the node glyph. */
  laneAfter: string
  /** The lane cells of a row drawn under this one, before the next node. */
  laneBelow: string
}

// What each lane glyph becomes one row lower, where no node sits: a lane
// that goes on draws `│`, a run or a merge end draws nothing.
const CONTINUES = new Set(['│', '┐', '┬', '┼'])

function continuation(lane: string, nodeContinues: boolean): string {
  return [...lane]
    .map(glyph => (glyph === NODE ? (nodeContinues ? '│' : ' ') : CONTINUES.has(glyph) ? '│' : ' '))
    .join('')
}

export function fileNameOf(relPath: string): string {
  return relPath.slice(relPath.lastIndexOf('/') + 1)
}

/** Keeps the end of a name, where the extension is, when the room is short. */
export function fitEnd(text: string, room: number): string {
  if (text.length <= room) return text
  if (room <= ELLIPSIS.length) return ELLIPSIS
  return ELLIPSIS + text.slice(text.length - (room - ELLIPSIS.length))
}

/** Keeps the start of a code line when the room is short. */
export function fitStart(text: string, room: number): string {
  if (text.length <= room) return text
  if (room <= ELLIPSIS.length) return ELLIPSIS
  return text.slice(0, room - ELLIPSIS.length) + ELLIPSIS
}

// After every file that has a level, in change order.
const LAST_LEVEL = Number.MAX_SAFE_INTEGER

function has(matrix: readonly (readonly boolean[])[], a: number, b: number): boolean {
  return matrix[a]?.[b] === true
}

/**
 * The level of each file, top of the pane first. A file's layer rank is its
 * lowest level, and a file sits at least one level below every file that names
 * it, so a caller draws above what it calls whatever its folder is called.
 * Files that name each other, directly or around a loop, share a level. A file
 * in Other that names files sits one level above the highest of them. A file
 * in no layer and with no edge has nothing to go by, so it goes last.
 */
function levelsOf(layers: readonly Layer[], calls: readonly (readonly boolean[])[]): number[] {
  const count = calls.length

  // reach[a][b]: a names b, directly or through other changed files.
  const reach = calls.map(row => [...row])
  for (let via = 0; via < count; via++) {
    for (const row of reach) {
      if (row[via] !== true) continue
      for (let b = 0; b < count; b++) if (has(reach, via, b)) row[b] = true
    }
  }
  const isLoop = (a: number, b: number) => has(reach, a, b) && has(reach, b, a)

  const levels = layers.map(layer => (layer === OTHER_LAYER ? 0 : layer.rank))
  // Levels only move down, and the edges between loops form no loop, so this ends.
  for (let isMoved = true; isMoved; ) {
    isMoved = false
    for (let a = 0; a < count; a++) {
      for (let b = 0; b < count; b++) {
        const level = levels[a] ?? 0
        const wanted = isLoop(a, b) ? level : has(calls, a, b) ? level + 1 : -1
        if (wanted > (levels[b] ?? 0)) {
          levels[b] = wanted
          isMoved = true
        }
      }
    }
  }

  // A file in Other has no rank to hold it, so after the pass above a caller in
  // Other still sits at level 0, above files it has no edge to. Move it down to
  // one level above the highest file it names. Files in a loop keep the loop's
  // level. A move stops above every callee, so no edge turns upward; levels only
  // move down, so this ends, and the result does not depend on the file order.
  const calleesOf = (a: number) => calls[a]?.flatMap((isCall, b) => (isCall ? [b] : [])) ?? []
  for (let isMoved = true; isMoved; ) {
    isMoved = false
    for (let a = 0; a < count; a++) {
      const callees = calleesOf(a)
      if (layers[a] !== OTHER_LAYER || has(reach, a, a) || callees.length === 0) continue
      const wanted = Math.min(...callees.map(b => levels[b] ?? 0)) - 1
      if (wanted > (levels[a] ?? 0)) {
        levels[a] = wanted
        isMoved = true
      }
    }
  }

  const isLinked = (a: number) => calls.some((_, b) => has(calls, a, b) || has(calls, b, a))
  return levels.map((level, a) => (layers[a] === OTHER_LAYER && !isLinked(a) ? LAST_LEVEL : level))
}

/**
 * Files sort by level, then by layer rank, then by change order, so the same
 * list always draws the same graph. Every edge points down that order: across
 * levels from a caller to what it names, and inside a level between files that
 * name each other.
 */
export function buildRows(files: readonly ChangedFile[], scans: readonly SymbolScan[]): MapRow[] {
  const found = files.map((file, index) => ({ file, scan: scans[index] ?? EMPTY_SCAN, layer: layerOf(file.relPath) }))
  const calls = found.map((caller, a) => found.map((callee, b) => a !== b && references(caller.scan, callee.scan)))
  const levels = levelsOf(found.map(entry => entry.layer), calls)
  const entries = found
    .map((entry, index) => ({ ...entry, index, level: levels[index] ?? 0 }))
    .sort((a, b) => a.level - b.level || a.layer.rank - b.layer.rank || a.file.order - b.file.order)

  const nodes = entries.map((upper, i) => ({
    children: entries.flatMap((lower, j) =>
      j > i && (has(calls, upper.index, lower.index) || has(calls, lower.index, upper.index)) ? [j] : [],
    ),
  }))

  const lanes = drawLanes(nodes)
  return entries.map((entry, i) => {
    const lane = lanes[i] ?? NODE
    const node = lane.indexOf(NODE)
    return {
      file: entry.file,
      layer: entry.layer,
      laneBefore: lane.slice(0, node),
      laneAfter: lane.slice(node + 1),
      laneBelow: continuation(lane, (nodes[i]?.children.length ?? 0) > 0),
    }
  })
}
