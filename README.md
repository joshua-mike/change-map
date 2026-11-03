# change-map

A Claude Code mod that keeps a pane beside the chat with every code file the
session changed. Each file is listed once, as a node in a git-style graph of
the request flow between the files, with the lines the session changed.

```
CHANGE MAP                              4 code files · request flows down

●    4  OrderTests.cs                                                 new
●─┐  2  OrderView.cs ×3                                      L12–14, L40
│ ●  3  OrderCalculator.cs                                             L8
●─┘  1  OrderDeletion.cs ×2                                        L62–70

Click a file to copy its name. Right: the lines the session changed, or new for a file it created.
An edge joins two files when one names a type or method that the other declares.
```

The pane opens on the first code file change. `/change-map` opens it again.

## What a row shows

- **The dot and the lanes.** The dot's color marks the file's layer. An edge
  joins two files when one names a type or method that the other declares,
  and the file it names sorts below it. So a request flows down the pane in
  any codebase, whatever its folders are called. The layers order the rest;
  see [Row order](#row-order).
- **The number.** The order in which the session first changed the file.
- **The file name.** A click copies the name to the clipboard. `×N` is how many
  times the file was found changed.
- **The right column.** The lines the session changed, as ranges: a run of
  consecutive lines is one range, and a single line stands alone. A file the
  session created shows `new` in green instead.

When the pane is narrow, the lines move under the file name.

## How changes are found

- An `Edit`, `Write` or `NotebookEdit` call lists its file at once, also
  outside git.
- After every tool call that can write a file, `Bash` and `PowerShell`
  included, and at the end of each turn, the mod polls git. `git status` gives
  the dirty and untracked files, and `git log` gives the files of the user's
  own commits since the session started. So a change made by a script, a
  shell command, a subagent, or a commit is found too.
- A file that was dirty before the session started counts only after its
  content changes.
- Every git worktree nested inside the session folder is polled as well, also
  one created during the session. A session that works in such a worktree is
  mapped even though the main checkout's git never sees those files.
- Files outside the session folder, such as a scratchpad, are ignored. So are
  files that are not code: documentation, configuration, images. A file counts
  as code by its extension; the list is in `hooks/layers.ts`.

The line ranges come from `git diff -U0` against the commit that was HEAD when
the session started, one range per hunk. Outside git, each `Edit` contributes
the lines its new text occupies.

## Row order

Each file gets a level, and the rows sort by level, then by layer rank, then
by the order of the first change.

- A file's layer rank is its lowest level: the highest it can sit in the pane.
- A file sits at least one level below every file that names it. When
  `main.go` names a function in `invoice.go`, which names one in `amount.go`,
  the three draw in that order, though no layer matches their folders.
- Files that name each other, directly or around a loop, share a level.
- A file in Other that names files sits one level above the highest of them.
  A `tools/` script that names a table in `db/` draws just above the table,
  not at the top of the pane above files it has no edge to.
- A file in Other with no edge goes last.

So the layers decide what the code leaves open, such as two files with no
edge between them. When the code and the layers disagree, the code wins: a
`utils/` file that names a type in `models/` sorts above it.

## Layers

The built-in layers match common folder names. The first match wins, and the
rank places the file in the [row order](#row-order).

| Rank | Layer       | Matches                                                      |
| ---- | ----------- | ------------------------------------------------------------ |
| 0    | Test        | `tests/`, `__tests__/`, `*.test.*`, `*.spec.*`, `*Tests.*`   |
| 1    | View        | `views/`, `pages/`, `components/`, `ui/`, `*.xaml`, `*.vue`  |
| 2    | Controller  | `controllers/`, `viewmodels/`, `presenters/`                 |
| 3    | Service     | `services/`, `domain/`, `logic/`, `usecases/`, `application/`|
| 4    | API client  | `client/`, `proxies/`, `sdk/`, `gateways/`                   |
| 5    | Server      | `server/`, `api/`, `routes/`, `endpoints/`, `handlers/`      |
| 6    | Data access | `repositories/`, `datastores/`, `persistence/`, `data/`      |
| 7    | Model       | `models/`, `entities/`, `dtos/`, `schemas/`, `types/`        |
| 8    | Database    | `*.sql`, `db/`, `database/`, `migrations/`                   |
| 9    | Shared      | `shared/`, `common/`, `lib/`, `utils/`, `core/`              |
| 10   | Other       | everything else                                              |

A project with its own folder names adds a `layers.local.json` next to
`.claude-plugin/`. Its layers match before the built-in ones. The file is
ignored by git, so it stays on your machine.

```json
[
  { "name": "Widget", "rank": 1, "pattern": "(^|/)widgets/", "color": "warning" },
  { "name": "Queue worker", "rank": 5, "pattern": "(^|/)workers?/" }
]
```

- `pattern` is a regular expression source, matched case-insensitively against
  the path relative to the session folder, with forward slashes. `(^|/)`
  anchors a folder name anywhere in the path.
- `rank` places the layer in the row order; it can repeat a built-in rank or
  sit between two.
- `color` is a Claude Code theme key, so the dot follows the light or dark
  theme. It is optional.

A problem in the file shows as a toast at session start, and the built-in
layers stay in place.

## Install

Clone the repository to a folder of your choice:

```bash
git clone https://github.com/joshua-mike/change-map.git ~/.claude/mods/change-map
```

Load it in every session through `~/.claude/settings.json`:

```json
{
  "env": {
    "CLAUDE_CODE_PLUGIN_DIRS": "C:\\Users\\<you>\\.claude\\mods\\change-map"
  }
}
```

Or load it for one session only:

```bash
claude --plugin-dir ~/.claude/mods/change-map
```

A session that is already open keeps the version it loaded. Start a new
session, or run `/reload-plugins`, after an update.

## Develop

Run the tests and the validator from the folder that holds the mod:

```bash
claude plugin test change-map
```

```bash
claude plugin validate change-map
```

Claude Code generates the type declarations in `.claude-plugin/types/` when it
loads the mod. `tsconfig.json` extends them, so an editor or `tsc` can type
check the hooks and the tests.

| Path                        | Holds                                                       |
| --------------------------- | ----------------------------------------------------------- |
| `hooks/register.tsx`        | The hooks: session start, tool calls, turn end, the pane    |
| `hooks/gitChanges.ts`       | The git baseline per repository or worktree, and the poll   |
| `hooks/lineRanges.ts`       | Changed lines from an edit or a diff, and their format      |
| `hooks/layers.ts`           | Code file extensions, the built-in layers, the local layers |
| `hooks/symbols.ts`          | The symbol scan that decides the edges                      |
| `hooks/dag.ts`              | The lane drawing                                            |
| `hooks/map.ts`              | Rows: edges, levels, sort, lanes                            |
| `types/index.d.ts`          | The stored state: one record per changed file               |
| `tests/change-map.test.tsx` | The tests, with a fake git                                  |

## Limits

- A commit counts only when its author is the repository's `user.email`, it
  is not a merge, and it was made after the session started. A branch switch
  or a merge adds nothing.
- The line ranges are read against the commit at session start, so a file
  that was dirty before the session shows those older lines too.
- Outside git, an `Edit` is located by its first code line. A line that
  repeats in the file can point at an earlier copy.
- The symbol scan is a heuristic, not a parser: a name of six or more
  characters that one file declares and the other mentions makes an edge.
  Since the edges set the row order, a false edge moves a file down, and a
  missed one leaves the file at its layer's place.

## License

MIT. See [LICENSE](LICENSE).
