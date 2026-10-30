// Finds which lines a change touched: from the text an Edit wrote, or from
// the hunks of a unified diff; and formats those lines for the pane.

import type { LineRange } from '../types'

const HUNK_HEADER = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/

function trimLine(line: string): string {
  return line.replace(/\t/g, '  ').trim()
}

/** The first line of `text` that holds code, and its 1-based index in `text`. */
export function firstCodeLine(text: string | undefined): { index: number; text: string } | undefined {
  if (text === undefined) return undefined
  const lines = text.split(/\r?\n/)
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? ''
    if (line.trim() !== '') return { index: i + 1, text: trimLine(line) }
  }
  return undefined
}

/**
 * The 1-based number of the first line of `content` that reads as `snippet`,
 * a line `firstCodeLine` produced. The first match wins: a line that repeats
 * in the file can point at an earlier copy.
 */
export function locateLine(content: string, snippet: string): number | undefined {
  const lines = content.split(/\r?\n/)
  for (let i = 0; i < lines.length; i++) {
    if (trimLine(lines[i] ?? '') === snippet) return i + 1
  }
  return undefined
}

/**
 * The lines an Edit's new text occupies in `content` after the edit, found by
 * its first code line. Undefined when that line is not in the file, or when
 * the edit only removed text.
 */
export function editRange(content: string, newText: string | undefined): LineRange | undefined {
  const first = firstCodeLine(newText)
  if (first === undefined || newText === undefined) return undefined
  const located = locateLine(content, first.text)
  if (located === undefined) return undefined
  const start = located - (first.index - 1)
  return { start, end: start + newText.split(/\r?\n/).length - 1 }
}

/** Sorted, with overlapping or adjacent ranges joined into one. */
export function mergeRanges(ranges: readonly LineRange[]): LineRange[] {
  const sorted = [...ranges].sort((a, b) => a.start - b.start || a.end - b.end)
  const merged: LineRange[] = []
  for (const range of sorted) {
    const last = merged[merged.length - 1]
    if (last !== undefined && range.start <= last.end + 1) last.end = Math.max(last.end, range.end)
    else merged.push({ ...range })
  }
  return merged
}

/** `L62–70, L752`: a run of lines as a range, a single line alone. */
export function formatRanges(ranges: readonly LineRange[]): string {
  return ranges.map(range => (range.start === range.end ? `L${range.start}` : `L${range.start}–${range.end}`)).join(', ')
}

export type DiffRanges = {
  /** True when the old side is `/dev/null`: the file did not exist at the base. */
  isNew: boolean
  /** One range per hunk, on the new side of the diff, in file order. */
  ranges: LineRange[]
}

/**
 * The changed lines of each file in a `git diff -U0` output, keyed by the
 * path git prints. With no context lines, each hunk is one run of changes.
 */
export function parseDiffRanges(diff: string): Map<string, DiffRanges> {
  const files = new Map<string, DiffRanges>()
  let path: string | undefined
  let isNew = false
  let isInHunk = false

  for (const raw of diff.split('\n')) {
    const line = raw.replace(/\r$/, '')
    if (line.startsWith('diff --git ')) {
      path = undefined
      isNew = false
      isInHunk = false
      continue
    }
    // The file headers come before the first hunk; after it, `---`/`+++` are content.
    if (!isInHunk) {
      if (line === '--- /dev/null') isNew = true
      else if (line.startsWith('+++ b/')) path = line.slice(6)
      else if (line.startsWith('--- a/') && path === undefined) path = line.slice(6)
    }
    const hunk = HUNK_HEADER.exec(line)
    if (hunk === null || path === undefined) continue
    isInHunk = true
    const start = Math.max(1, Number(hunk[1]))
    const count = hunk[2] === undefined ? 1 : Number(hunk[2])
    const file = files.get(path) ?? { isNew, ranges: [] }
    file.ranges.push({ start, end: start + Math.max(0, count - 1) })
    files.set(path, file)
  }
  return files
}
