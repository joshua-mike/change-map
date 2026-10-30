// Turns the changed-file list into the rows of the code map: one per file,
// with its graph lane, its layer, and its changed lines.

import type { ChangedFile } from '../types'
import { drawLanes } from './dag'
import { layerOf, type Layer } from './layers'
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

/**
 * Files sort by layer rank (caller layers first), then by change order, so the
 * same list always draws the same graph. An edge always points down that
 * order: when a lower layer names an upper one, the edge still joins them,
 * because the map shows relation, not exact call direction.
 */
export function buildRows(files: readonly ChangedFile[], scans: readonly SymbolScan[]): MapRow[] {
  const entries = files
    .map((file, index) => ({ file, scan: scans[index] ?? EMPTY_SCAN, layer: layerOf(file.relPath) }))
    .sort((a, b) => a.layer.rank - b.layer.rank || a.file.order - b.file.order)

  const nodes = entries.map((upper, i) => ({
    children: entries.flatMap((lower, j) =>
      j > i && (references(upper.scan, lower.scan) || references(lower.scan, upper.scan)) ? [j] : [],
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
