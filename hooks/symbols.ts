// A coarse, language-agnostic symbol scan: what a file declares, and which
// identifiers it mentions. It is a heuristic for a high-level map, not a parser.

export type SymbolScan = {
  declares: ReadonlySet<string>
  mentions: ReadonlySet<string>
}

export const EMPTY_SCAN: SymbolScan = { declares: new Set(), mentions: new Set() }

// Shorter names (Get, Item, Save) match far too much text to mean a real link.
const MIN_NAME_LENGTH = 6

// Names that many unrelated files declare or override; a match on one says nothing.
const NOISE = new Set([
  'ToString', 'Equals', 'GetHashCode', 'Dispose', 'Finalize', 'GetEnumerator',
  'Initialize', 'InitializeComponent', 'Execute', 'Configure', 'ConfigureServices',
  'OnPropertyChanged', 'PropertyChanged', 'Program', 'Startup', 'constructor',
  'render', 'default', 'register', 'return', 'public', 'private', 'static',
])

// No `namespace`/`module`: a file that only imports a namespace would look like a caller of it.
const TYPE_DECLARATION = /\b(?:class|interface|enum|struct|record|trait|type)\s+([A-Za-z_]\w*)/g
const FUNCTION_DECLARATION = /\b(?:function|def|func|fn|Sub|Function)\s+([A-Za-z_]\w*)/g
const SQL_DECLARATION =
  /\bcreate\s+(?:or\s+replace\s+)?(?:editionable\s+)?(?:table|view|trigger|package(?:\s+body)?|procedure|function|sequence)\s+(?:"?\w+"?\.)?"?(\w+)"?/gi
const VISIBLE_MEMBER_LINE = /\b(?:public|internal|protected|export)\b/
const OVERRIDE = /\boverride\b/
const FIRST_CALLABLE_NAME = /([A-Za-z_]\w*)\s*(?:<[^>()]*>)?\s*\(/
const NOT_A_MEMBER_NAME = new Set(['if', 'for', 'foreach', 'while', 'switch', 'catch', 'using', 'lock', 'new', 'return', 'typeof', 'nameof', 'sizeof', 'base', 'this'])
const IDENTIFIER = /[A-Za-z_]\w*/g

function isUseful(name: string): boolean {
  return name.length >= MIN_NAME_LENGTH && !NOISE.has(name)
}

function addMatches(text: string, pattern: RegExp, into: Set<string>): void {
  for (const match of text.matchAll(pattern)) {
    const name = match[1]
    if (name !== undefined && isUseful(name)) into.add(name)
  }
}

export function scanSymbols(text: string): SymbolScan {
  const declares = new Set<string>()
  addMatches(text, TYPE_DECLARATION, declares)
  addMatches(text, FUNCTION_DECLARATION, declares)
  addMatches(text, SQL_DECLARATION, declares)

  // Visible members (C#, Java, TS exports). Overrides are skipped: every view
  // overrides the same framework methods, and that is not a link between files.
  for (const line of text.split('\n')) {
    if (!VISIBLE_MEMBER_LINE.test(line) || OVERRIDE.test(line)) continue
    const name = FIRST_CALLABLE_NAME.exec(line)?.[1]
    if (name !== undefined && !NOT_A_MEMBER_NAME.has(name) && isUseful(name)) declares.add(name)
  }

  // Identifiers inside string literals count on purpose: a client often names a
  // remote method by string (invoke("MethodName", ...)).
  const mentions = new Set<string>()
  for (const match of text.matchAll(IDENTIFIER)) {
    if (isUseful(match[0])) mentions.add(match[0])
  }

  return { declares, mentions }
}

/**
 * True when `caller` mentions a name that `callee` declares. A name both files
 * declare (the parts of a C# partial class) is shared, not a call.
 */
export function references(caller: SymbolScan, callee: SymbolScan): boolean {
  for (const name of callee.declares) {
    if (!caller.declares.has(name) && caller.mentions.has(name)) return true
  }
  return false
}
