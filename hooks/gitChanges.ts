// Reads the files this session changed from git, so a change that a shell
// command, a script, or a subagent made is found, not only an Edit or Write.
// Every path here is repo-relative with forward slashes, as git prints it.

import type { EngineInterface } from 'claude-code'

import type { LineRange } from '../types'
import { parseDiffRanges, type DiffRanges } from './lineRanges'

const DELETED = 'deleted'

export type GitBaseline = {
  /** The repository or worktree top level, as `git rev-parse --show-toplevel` prints it. */
  root: string
  /** HEAD when the baseline was taken: the commit the changed lines are read against. */
  startHead: string
  /** The last HEAD a poll saw; empty before the first commit. */
  head: string
  /** Seconds since the epoch when the baseline was taken. */
  startedAt: number
  authorEmail: string
  /**
   * Files that were already dirty before the session started, with their
   * content hash. Such a file counts as changed only after its hash moves.
   */
  preexisting: Map<string, string>
}

type StatusEntry = { path: string; isDeleted: boolean; isUntracked: boolean }

type GitResult = { isOk: boolean; stdout: string }

async function git($: EngineInterface, cwd: string, args: string[], stdin?: string): Promise<GitResult> {
  try {
    const run = await $.process.run(['git', ...args], { cwd, stdin })
    return { isOk: run.exitCode === 0, stdout: run.stdout }
  } catch {
    return { isOk: false, stdout: '' }
  }
}

/**
 * Files whose working-tree copy differs from the index, and untracked files.
 * A staged-only file is left out: a merge stages every file it brings in, and
 * the session's own staged work is found through its dirty state or its commit.
 */
async function readStatus($: EngineInterface, root: string): Promise<StatusEntry[]> {
  const status = await git($, root, ['status', '--porcelain=v1', '-z', '--untracked-files=all'])
  if (!status.isOk) return []

  const fields = status.stdout.split('\0')
  const entries: StatusEntry[] = []
  for (let i = 0; i < fields.length; i++) {
    const field = fields[i] ?? ''
    if (field.length < 4) continue
    const indexCode = field[0]
    const worktreeCode = field[1]
    // A rename or copy writes its source path as the next field.
    if (indexCode === 'R' || indexCode === 'C') i++
    const isConflict =
      indexCode === 'U' || worktreeCode === 'U' || (indexCode === 'A' && worktreeCode === 'A') || (indexCode === 'D' && worktreeCode === 'D')
    if (isConflict) continue
    const isUntracked = indexCode === '?'
    if (isUntracked || worktreeCode !== ' ') {
      entries.push({ path: field.slice(3), isDeleted: worktreeCode === 'D', isUntracked })
    }
  }
  return entries
}

async function hashEntries($: EngineInterface, root: string, entries: readonly StatusEntry[]): Promise<Map<string, string>> {
  const hashes = new Map<string, string>()
  const present = entries.filter(entry => !entry.isDeleted)
  for (const entry of entries) if (entry.isDeleted) hashes.set(entry.path, DELETED)
  if (present.length === 0) return hashes

  const hashed = await git($, root, ['hash-object', '--stdin-paths'], present.map(entry => entry.path).join('\n') + '\n')
  const lines = hashed.stdout.split(/\r?\n/)
  // A failed call leaves the hash empty, so the file counts as changed.
  present.forEach((entry, index) => hashes.set(entry.path, hashed.isOk ? (lines[index] ?? '') : ''))
  return hashes
}

async function readHead($: EngineInterface, root: string): Promise<string> {
  return (await git($, root, ['rev-parse', '--verify', '-q', 'HEAD'])).stdout.trim()
}

function escapeRegex(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/** The top level of the repository or worktree that holds `dir`; undefined outside git. */
export async function repoRootOf($: EngineInterface, dir: string): Promise<string | undefined> {
  const topLevel = await git($, dir, ['rev-parse', '--show-toplevel'])
  return topLevel.isOk ? topLevel.stdout.trim() : undefined
}

/**
 * Every worktree of the repository that holds `root`, the main one included,
 * as git prints them. A session can work in a worktree nested inside its
 * directory, where the main checkout's git never sees the files.
 */
export async function listWorktrees($: EngineInterface, root: string): Promise<string[]> {
  const list = await git($, root, ['worktree', 'list', '--porcelain'])
  const roots = list.stdout
    .split(/\r?\n/)
    .filter(line => line.startsWith('worktree '))
    .map(line => line.slice('worktree '.length).trim())
  return roots.length === 0 ? [root] : roots
}

/** Takes the baseline of the repository or worktree whose top level is `root`. */
export async function takeBaseline($: EngineInterface, root: string): Promise<GitBaseline> {
  const entries = await readStatus($, root)
  const head = await readHead($, root)
  return {
    root,
    startHead: head,
    head,
    startedAt: Math.floor((await $.clock.now()) / 1000),
    authorEmail: (await git($, root, ['config', 'user.email'])).stdout.trim(),
    preexisting: await hashEntries($, root, entries),
  }
}

export type PolledChange = {
  /** Absolute path with forward slashes. */
  absPath: string
  /** True when the file did not exist before the session's changes. */
  isNew: boolean
  /** The lines changed since the session's start commit; empty when unknown. */
  ranges: LineRange[]
  /**
   * True when `ranges` came from the diff, so they replace what is stored.
   * False for an untracked file, a binary file, or a repository with no commit.
   */
  isFromDiff: boolean
}

type FoundChange = { isNew: boolean }

function noteChange(found: Map<string, FoundChange>, path: string, isNew: boolean): void {
  const known = found.get(path)
  if (known === undefined) found.set(path, { isNew })
  else known.isNew = known.isNew || isNew
}

/**
 * The files of the user's own commits after the baseline, with `A` marking a
 * new file. `-z --name-status` prints status and path pairs; a rename or copy
 * prints the source path between them.
 */
function parseNameStatus(log: string, found: Map<string, FoundChange>): void {
  const fields = log.split('\0')
  for (let i = 0; i + 1 < fields.length; i++) {
    const status = fields[i] ?? ''
    if (status === '') continue
    if (status.startsWith('R') || status.startsWith('C')) i++
    i++
    const path = (fields[i] ?? '').trim()
    if (path !== '') noteChange(found, path, status.startsWith('A'))
  }
}

/**
 * The changed lines of each path, read from the diff against the session's
 * start commit. A file that was dirty before the session shows those lines too.
 */
async function readDiff($: EngineInterface, baseline: GitBaseline, paths: readonly string[]): Promise<Map<string, DiffRanges>> {
  if (baseline.startHead === '' || paths.length === 0) return new Map()
  const diff = await git($, baseline.root, [
    '-c', 'core.quotePath=false', 'diff', '-U0', '--no-color', '--no-ext-diff', baseline.startHead, '--', ...paths,
  ])
  return diff.isOk ? parseDiffRanges(diff.stdout) : new Map()
}

/**
 * Returns the files changed since the baseline, absolute with forward slashes,
 * and moves `baseline.head` to the current HEAD.
 *
 * A commit counts only when it is the user's own, not a merge, and made after
 * the baseline. So a branch switch, or a merge of another branch, adds nothing.
 */
export async function pollChanges($: EngineInterface, baseline: GitBaseline): Promise<PolledChange[]> {
  const found = new Map<string, FoundChange>()

  const entries = await readStatus($, baseline.root)
  const hashes = await hashEntries(
    $,
    baseline.root,
    entries.filter(entry => baseline.preexisting.has(entry.path)),
  )
  for (const entry of entries) {
    const before = baseline.preexisting.get(entry.path)
    if (before === undefined) noteChange(found, entry.path, entry.isUntracked)
    else if (hashes.get(entry.path) !== before) noteChange(found, entry.path, false)
  }

  const head = await readHead($, baseline.root)
  if (head !== '' && head !== baseline.head) {
    const isDescendant =
      baseline.head === '' || (await git($, baseline.root, ['merge-base', '--is-ancestor', baseline.head, head])).isOk
    if (isDescendant) {
      const range = baseline.head === '' ? head : `${baseline.head}..${head}`
      const author = baseline.authorEmail === '' ? [] : [`--author=${escapeRegex(baseline.authorEmail)}`]
      const log = await git($, baseline.root, [
        'log', '-z', '--no-merges', '--format=', '--name-status', `--since=@${baseline.startedAt}`, ...author, range,
      ])
      parseNameStatus(log.stdout, found)
    }
    baseline.head = head
  }

  const paths = [...found.keys()]
  const diffByPath = await readDiff($, baseline, paths)
  const root = baseline.root.replace(/\\/g, '/').replace(/\/+$/, '')
  return paths.map(path => {
    const diff = diffByPath.get(path)
    const isNew = (found.get(path)?.isNew ?? false) || (diff?.isNew ?? false)
    return { absPath: `${root}/${path}`, isNew, ranges: isNew ? [] : (diff?.ranges ?? []), isFromDiff: diff !== undefined }
  })
}
