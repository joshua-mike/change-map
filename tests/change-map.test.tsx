import { expect, test } from 'claude-code/testing'

import { drawLanes } from '../hooks/dag'
import { layerOf, useLocalLayers } from '../hooks/layers'
import { editRange, formatRanges, mergeRanges, parseDiffRanges } from '../hooks/lineRanges'

const ROOT = 'C:\\repo'
const VIEW = `${ROOT}\\src\\Views\\OrderView.cs`
const LOGIC = `${ROOT}\\src\\Services\\OrderCalculator.cs`
const SERVER = `${ROOT}\\src\\Server\\Handlers\\OrderDeletion.cs`
const NEW_TEST = `${ROOT}\\tests\\OrderTests.cs`
const README = `${ROOT}\\docs\\README.md`
const SCRATCH_SCRIPT = 'C:\\Temp\\claude\\scratchpad\\apply_fix.py'

const VIEW_REL = 'src/Views/OrderView.cs'
const LOGIC_REL = 'src/Services/OrderCalculator.cs'
const SERVER_REL = 'src/Server/Handlers/OrderDeletion.cs'
const NEW_TEST_REL = 'tests/OrderTests.cs'

const VIEW_KEY = `file:c:/repo/${VIEW_REL.toLowerCase()}`
const LOGIC_KEY = `file:c:/repo/${LOGIC_REL.toLowerCase()}`
const SERVER_KEY = `file:c:/repo/${SERVER_REL.toLowerCase()}`
const NEW_TEST_KEY = `file:c:/repo/${NEW_TEST_REL.toLowerCase()}`

// A worktree nested inside the working directory, as the desktop app makes them.
const WORKTREE = 'C:/repo/.claude/worktrees/feature-1'
const WORKTREE_VIEW_KEY = `file:${WORKTREE.toLowerCase()}/${VIEW_REL.toLowerCase()}`
const WORKTREE_SERVER_KEY = `file:${WORKTREE.toLowerCase()}/${SERVER_REL.toLowerCase()}`

const VIEW_CONTENT = [
  'public class OrderView {',
  '  void Load() {',
  '    OrderCalculator.Compute();',
  '    SendRequest("DeleteOrder", x);',
  '  }',
  '}',
].join('\n')

// Keyed by forward-slash path: git prints that form, the Edit tool the other.
const CONTENT: Record<string, string> = {
  [`C:/repo/${VIEW_REL}`]: VIEW_CONTENT,
  [`C:/repo/${LOGIC_REL}`]: 'public class OrderCalculator { public static int Compute() { return 1; } }',
  [`C:/repo/${SERVER_REL}`]: 'public partial class Handlers {\n  public Stream DeleteOrder(RequestArgs args) { }\n}',
  [`C:/repo/${NEW_TEST_REL}`]: 'using Xunit;\npublic class OrderTests { }',
  'C:/repo/docs/README.md': '# Notes',
}

const PANE = {
  plugin: 'change-map',
  component: 'Pane',
  requestId: 'change-map',
  props: {
    title: 'Change map',
    isFocused: false,
    bodyColumns: 120,
    placement: 'dock',
    scroll: { offset: 0, bodyRows: 40 },
    view: {},
  },
} as const

/** A fake repository or worktree: the test sets what git answers from its root. */
type FakeRepo = { status: string; head: string; log: string; diff: string; hashes: Record<string, string> }

/** Fake repositories by root; `worktrees` is what `git worktree list` prints from any of them. */
type FakeGit = { repos: Record<string, FakeRepo>; worktrees: string[] }

function run(stdout: string, exitCode = 0) {
  return { value: { exitCode, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
}

function fakeRepo(repo: Partial<FakeRepo> = {}): FakeRepo {
  return { status: '', head: 'aaa', log: '', diff: '', hashes: {}, ...repo }
}

function answerGit(git: FakeGit | undefined, argv: readonly string[], cwd: string | undefined, stdin: string | undefined) {
  const root = (cwd ?? '').replace(/\\/g, '/').replace(/\/+$/, '')
  if (git === undefined) return run('', 128)
  const repo = git.repos[root]
  if (repo === undefined) return run('', 128)
  const args = argv.slice(1).join(' ')
  if (args === 'rev-parse --show-toplevel') return run(`${root}\n`)
  if (args === 'rev-parse --verify -q HEAD') return run(`${repo.head}\n`)
  if (args === 'config user.email') return run('dev@example.com\n')
  if (args === 'worktree list --porcelain') return run(git.worktrees.map(path => `worktree ${path}\nHEAD aaa\n\n`).join(''))
  if (args.startsWith('status')) return run(repo.status)
  if (args.startsWith('merge-base --is-ancestor')) return run('')
  if (args.startsWith('log')) return run(repo.log)
  if (args.includes(' diff -U0 ')) return run(repo.diff)
  if (args === 'hash-object --stdin-paths') {
    const paths = (stdin ?? '').split('\n').filter(Boolean)
    return run(paths.map(path => repo.hashes[path] ?? 'unknown').join('\n') + '\n')
  }
  return run('', 1)
}

function edit(file_path: string, new_string = 'b') {
  return { tool: 'Edit', file_path, old_string: 'a', new_string } as const
}

function hunk(path: string, header: string, ...lines: string[]): string {
  return [`diff --git a/${path} b/${path}`, `--- a/${path}`, `+++ b/${path}`, header, ...lines, ''].join('\n')
}

function newFileHunk(path: string, ...lines: string[]): string {
  return [`diff --git a/${path} b/${path}`, '--- /dev/null', `+++ b/${path}`, `@@ -0,0 +1,${lines.length} @@`, ...lines, ''].join('\n')
}

/** `git log -z --name-status` output: status and path pairs. */
function nameStatus(...pairs: [string, string][]): string {
  return pairs.map(([status, path]) => `${status}\0${path}\0`).join('')
}

async function hasText(ui: { find: (q: { type?: string; text?: string | RegExp }) => Promise<unknown> }, text: string | RegExp) {
  return (await ui.find({ type: 'Text', text })) !== undefined
}

test('Edit and Write calls map each code file once, by name, with the lines each edit changed', async ($, on) => {
  let opens = 0
  let copied: string | undefined
  on('command.register', () => ({ value: { command: 'change-map' } }))
  on('ui.open', () => {
    opens += 1
    return { value: { isPlaced: true } }
  })
  on('ui.copy', (_, e) => {
    copied = e.text
    return { value: { isCopied: true } as const }
  })
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('tool.call', () => ({ result: {} }))
  on('process.run', (_, e) => answerGit(undefined, e.argv, e.init?.cwd, e.init?.stdin))
  on('fs.read', (_, e) => ({ value: CONTENT[e.path.replace(/\\/g, '/')] ?? '' }))
  on('fs.exists', (_, e) => ({ value: e.path.replace(/\\/g, '/') in CONTENT && !e.path.endsWith('OrderTests.cs') }))

  await $.session.start({ cwd: ROOT, surface: 'desktop', isInteractive: true })
  await $.tool.call(edit(README))
  await $.tool.call({ tool: 'Write', file_path: SCRATCH_SCRIPT, content: 'print(1)' })
  expect(opens).toBe(0)

  await $.tool.call(edit(VIEW, '    OrderCalculator.Compute();'))
  expect(opens).toBe(1)
  await $.tool.call(edit(SERVER, 'public Stream DeleteOrder(RequestArgs args) { }'))
  // A second edit on the next line joins the first into one range.
  await $.tool.call(edit(VIEW, 'SendRequest("DeleteOrder", x);'))
  await $.tool.call(edit(LOGIC, 'nothing in the file reads like this'))
  // A Write of a file that is not there yet makes a new file; a later edit keeps it new.
  await $.tool.call({ tool: 'Write', file_path: NEW_TEST, content: CONTENT[`C:/repo/${NEW_TEST_REL}`] ?? '' })
  await $.tool.call(edit(NEW_TEST, 'public class OrderTests { }'))
  expect(opens).toBe(1)

  for (const surface of ['terminal', 'desktop', 'vscode', 'mobile'] as const) {
    const ui = await $.ui.mount({ ...PANE, surface })
    // Caller layers first: Test, View, Service, Server.
    expect((await ui.findAll({ type: 'Button' })).map(button => button.key)).toEqual([NEW_TEST_KEY, VIEW_KEY, LOGIC_KEY, SERVER_KEY])

    const view = await ui.find({ key: VIEW_KEY })
    expect(view?.text).toMatch(/OrderView\.cs/)
    expect(view?.text).toMatch(/×2/)
    // No layer badge after the name.
    expect(view?.text).not.toMatch(/VIEW/)
    expect(await hasText(ui, 'L3–4')).toBe(true)
    expect(await hasText(ui, 'L2')).toBe(true)
    // The code itself is not shown.
    expect(await hasText(ui, 'OrderCalculator.Compute();')).toBe(false)
    // A new file shows `new`, not its lines.
    expect(await hasText(ui, 'new')).toBe(true)
    expect(await hasText(ui, 'L1')).toBe(false)
    expect((await ui.find({ key: NEW_TEST_KEY }))?.text).toMatch(/×2/)
    expect(await hasText(ui, /4 code files/)).toBe(true)

    copied = undefined
    await ui.press({ key: SERVER_KEY })
    expect(copied).toBe('OrderDeletion.cs')
    await ui.unmount()
  }

  // A narrow pane puts the lines under the name, with the lanes continued.
  const narrow = await $.ui.mount({ ...PANE, surface: 'terminal', props: { ...PANE.props, bodyColumns: 30 } })
  expect(await hasText(narrow, 'L3–4')).toBe(true)
  await narrow.unmount()
})

test('git finds files that a shell command, a subagent and a commit changed, with the lines of every hunk', async ($, on) => {
  const repo = fakeRepo({
    // LOGIC was dirty before the session started.
    status: ` M ${LOGIC_REL}\0`,
    hashes: { [LOGIC_REL]: 'hash-before' },
  })
  const git: FakeGit = { repos: { 'C:/repo': repo }, worktrees: ['C:/repo'] }
  let opens = 0
  on('command.register', () => ({ value: { command: 'change-map' } }))
  on('ui.open', () => {
    opens += 1
    return { value: { isPlaced: true } }
  })
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('tool.call', () => ({ result: {} }))
  on('process.run', (_, e) => answerGit(git, e.argv, e.init?.cwd, e.init?.stdin))
  on('clock.now', () => ({ value: 1_793_000_000_000 }))
  on('fs.read', (_, e) => ({ value: CONTENT[e.path.replace(/\\/g, '/')] ?? '' }))
  on('fs.exists', () => ({ value: true }))

  await $.session.start({ cwd: ROOT, surface: 'desktop', isInteractive: true })

  // A script writes the view and creates a test; a non-code file and the untouched dirty file stay off the list.
  repo.status = ` M ${LOGIC_REL}\0 M docs/README.md\0 M ${VIEW_REL}\0?? ${NEW_TEST_REL}\0`
  repo.diff = hunk(VIEW_REL, '@@ -2,0 +3 @@', '+    OrderCalculator.Compute();')
  await $.tool.call({ tool: 'Bash', command: 'py apply_fix.py' })
  expect(opens).toBe(1)

  // A subagent commits the work in one shell command: the test is added, the view grows a second hunk, the server changes.
  repo.status = ` M ${LOGIC_REL}\0`
  repo.head = 'bbb'
  repo.log = nameStatus(['M', VIEW_REL], ['A', NEW_TEST_REL], ['M', SERVER_REL])
  repo.diff =
    hunk(VIEW_REL, '@@ -2,0 +3 @@', '+    OrderCalculator.Compute();', '@@ -5 +6,2 @@', '-}', '+  void Save() { }', '+}') +
    newFileHunk(NEW_TEST_REL, '+using Xunit;', '+public class OrderTests { }') +
    hunk(SERVER_REL, '@@ -2 +2 @@', '-  public Stream DeleteOrder() { }', '+  public Stream DeleteOrder(RequestArgs args) { }')
  await $.tool.call({ tool: 'Bash', command: 'git commit -am x', agentId: 'a1' })

  // The dirty file counts once its content moves.
  repo.hashes[LOGIC_REL] = 'hash-after'
  repo.diff = hunk(LOGIC_REL, '@@ -1 +1 @@', '-public class OrderCalculator { }', '+public class OrderCalculator { public static int Compute() { return 1; } }')
  await $.tool.call({ tool: 'PowerShell', command: 'Set-Content x' })

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect((await ui.findAll({ type: 'Button' })).map(button => button.key)).toEqual([NEW_TEST_KEY, VIEW_KEY, LOGIC_KEY, SERVER_KEY])
  // The commit's diff replaced the view's earlier single range.
  expect(await hasText(ui, 'L3, L6–7')).toBe(true)
  expect(await hasText(ui, 'L2')).toBe(true)
  expect(await hasText(ui, 'L1')).toBe(true)
  expect(await hasText(ui, 'new')).toBe(true)
  expect(await hasText(ui, 'OrderCalculator.Compute();')).toBe(false)
  await ui.unmount()
})

test('a worktree nested inside the working directory is polled, also when it appears mid-session', async ($, on) => {
  const main = fakeRepo()
  const worktree = fakeRepo({ head: 'ccc' })
  const git: FakeGit = { repos: { 'C:/repo': main }, worktrees: ['C:/repo'] }
  on('command.register', () => ({ value: { command: 'change-map' } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('tool.call', () => ({ result: {} }))
  on('process.run', (_, e) => answerGit(git, e.argv, e.init?.cwd, e.init?.stdin))
  on('clock.now', () => ({ value: 1_793_000_000_000 }))
  on('fs.read', (_, e) => ({ value: CONTENT[e.path.replace(WORKTREE, 'C:/repo').replace(/\\/g, '/')] ?? '' }))
  on('fs.exists', () => ({ value: true }))

  await $.session.start({ cwd: ROOT, surface: 'desktop', isInteractive: true })

  // The session cuts a worktree; the next poll finds it with nothing changed yet.
  git.repos[WORKTREE] = worktree
  git.worktrees = ['C:/repo', WORKTREE, 'C:/elsewhere/other']
  await $.tool.call({ tool: 'Bash', command: 'git worktree add .claude/worktrees/feature-1' })
  const empty = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect(await hasText(empty, 'No code files changed yet.')).toBe(true)
  await empty.unmount()

  // A subagent's script edits the view inside the worktree; the main checkout stays clean.
  worktree.status = ` M ${VIEW_REL}\0`
  worktree.diff = hunk(VIEW_REL, '@@ -2,0 +3 @@', '+    OrderCalculator.Compute();')
  await $.tool.call({ tool: 'Bash', command: 'py apply_fix.py', agentId: 'a1' })

  // Then it commits the view and a server change.
  worktree.status = ''
  worktree.head = 'ddd'
  worktree.log = nameStatus(['M', VIEW_REL], ['M', SERVER_REL])
  worktree.diff =
    hunk(VIEW_REL, '@@ -2,0 +3 @@', '+    OrderCalculator.Compute();') +
    hunk(SERVER_REL, '@@ -2 +2 @@', '-  public Stream DeleteOrder() { }', '+  public Stream DeleteOrder(RequestArgs args) { }')
  await $.tool.call({ tool: 'Bash', command: 'git commit -am x', agentId: 'a1' })

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect((await ui.findAll({ type: 'Button' })).map(button => button.key)).toEqual([WORKTREE_VIEW_KEY, WORKTREE_SERVER_KEY])
  expect(await hasText(ui, 'OrderView.cs')).toBe(true)
  expect(await hasText(ui, 'L3')).toBe(true)
  expect(await hasText(ui, 'L2')).toBe(true)
  await ui.unmount()
})

test('layers.local.json puts a project layer before the built-in ones', async ($, on) => {
  const LOCAL_LAYERS = JSON.stringify([{ name: 'Widget', rank: 0, pattern: '(^|/)widgets/', color: 'warning' }])
  const WIDGET = `${ROOT}\\src\\Views\\widgets\\Dial.cs`
  const WIDGET_KEY = 'file:c:/repo/src/views/widgets/dial.cs'
  on('command.register', () => ({ value: { command: 'change-map' } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('tool.call', () => ({ result: {} }))
  on('process.run', (_, e) => answerGit(undefined, e.argv, e.init?.cwd, e.init?.stdin))
  on('fs.exists', (_, e) => ({ value: e.path.endsWith('layers.local.json') || e.path.replace(/\\/g, '/') in CONTENT }))
  on('fs.read', (_, e) => ({ value: e.path.endsWith('layers.local.json') ? LOCAL_LAYERS : (CONTENT[e.path.replace(/\\/g, '/')] ?? 'class Dial { }') }))

  await $.session.start({ cwd: ROOT, surface: 'desktop', isInteractive: true })
  await $.tool.call(edit(VIEW, 'nothing'))
  await $.tool.call(edit(WIDGET, 'nothing'))

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  // Without the local layer the widget would be a View, listed after OrderView.
  expect((await ui.findAll({ type: 'Button' })).map(button => button.key)).toEqual([WIDGET_KEY, VIEW_KEY])
  await ui.unmount()
})

test('a pane with no changes says so', async ($, on) => {
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect((await ui.find({ type: 'Text' }))?.text).toBe('No code files changed yet.')
  await ui.unmount()
})

test('two callers of one callee merge into its lane', async () => {
  expect(drawLanes([{ children: [2] }, { children: [2] }, { children: [] }])).toEqual(['●  ', '│ ●', '●─┘'])
})

test('built-in layers rank a request path from the test down to the database', async () => {
  const names = ['tests/OrderTests.cs', 'src/Views/OrderView.cs', 'src/Services/OrderCalculator.cs', 'src/Server/Handlers/OrderDeletion.cs', 'db/orders.sql', 'README.cs']
  expect(names.map(path => layerOf(path).name)).toEqual(['Test', 'View', 'Service', 'Server', 'Database', 'Other'])
  expect(useLocalLayers([{ name: 'Bad', rank: 1, pattern: '(' }])).toMatch(/^layer 1: Bad: /)
  expect(useLocalLayers({})).toBe('must be a JSON array of layers')
  expect(useLocalLayers([])).toBeUndefined()
})

test('a diff gives the hunks of each file: new, removed, mixed, two hunks, and a content line that looks like a header', async () => {
  const diff =
    newFileHunk('new.cs', '+', '+class NewOne { }') +
    hunk('gone.cs', '@@ -4,2 +3,0 @@', '-  int removed;', '-  int alsoRemoved;') +
    hunk('mixed.cs', '@@ -10 +10,2 @@', '-old line', '+new line', '+--- a/not-a-header.cs') +
    hunk('two.cs', '@@ -1 +1 @@', '-a', '+b', '@@ -5,2 +5,3 @@', '-c', '+d', '+e', '+f') +
    ['diff --git a/dead.cs b/dead.cs', '--- a/dead.cs', '+++ /dev/null', '@@ -1 +0,0 @@', '-class Dead { }', ''].join('\n')
  const files = parseDiffRanges(diff)
  expect(files.get('new.cs')).toEqual({ isNew: true, ranges: [{ start: 1, end: 2 }] })
  expect(files.get('gone.cs')).toEqual({ isNew: false, ranges: [{ start: 3, end: 3 }] })
  expect(files.get('mixed.cs')).toEqual({ isNew: false, ranges: [{ start: 10, end: 11 }] })
  expect(files.get('two.cs')).toEqual({ isNew: false, ranges: [{ start: 1, end: 1 }, { start: 5, end: 7 }] })
  expect(files.get('dead.cs')).toEqual({ isNew: false, ranges: [{ start: 1, end: 1 }] })
  expect(files.has('not-a-header.cs')).toBe(false)
})

test('ranges join when they touch, and an edit spans the lines its text occupies', async () => {
  const ranges = mergeRanges([{ start: 5, end: 5 }, { start: 1, end: 2 }, { start: 3, end: 3 }, { start: 9, end: 10 }, { start: 10, end: 12 }])
  expect(formatRanges(ranges)).toBe('L1–3, L5, L9–12')
  // The first code line sits on line 3 of the file and is the second line of the edit.
  expect(editRange(VIEW_CONTENT, '\n    OrderCalculator.Compute();\n    SendRequest("DeleteOrder", x);')).toEqual({ start: 2, end: 4 })
  expect(editRange(VIEW_CONTENT, 'not in the file')).toBeUndefined()
  expect(editRange(VIEW_CONTENT, '')).toBeUndefined()
})
