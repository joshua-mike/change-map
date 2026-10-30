// Draws a DAG as git-style lanes in box-drawing characters, one row per node.
//
//   ●─┐      View     Views/OrderView.cs
//   │ ●      Service  Services/OrderCalculator.cs
//   ●─┘      Server   Server/Handlers/OrderDeletion.cs
//
// A lane is a column that waits for one node. A node row ends every lane that
// waits for it (merges, `┘`/`┴`) and starts a lane for each extra child
// (forks, `┐`/`┬`). Every horizontal run goes right from the node, so a lane
// it crosses shows `┼`.

export type DagNode = {
  /** Indexes of child nodes. Every child index is greater than its parent's. */
  children: readonly number[]
}

const NODE = '●'
const VERTICAL = '│'
const HORIZONTAL = '─'
const CROSS = '┼'

/** One graph prefix per node, all padded to the same width. */
export function drawLanes(nodes: readonly DagNode[]): string[] {
  const rows: string[] = []
  const lanes: (number | null)[] = []

  nodes.forEach((node, index) => {
    const before = [...lanes]
    const waiting = before.flatMap((target, lane) => (target === index ? [lane] : []))

    // A node no lane waits for is a root: it takes the first free column.
    const firstFree = before.indexOf(null)
    const column = waiting[0] ?? (firstFree === -1 ? before.length : firstFree)
    const merges = waiting.slice(1)
    for (const lane of waiting) lanes[lane] = null
    lanes[column] = null

    const forks: number[] = []
    const [firstChild, ...otherChildren] = node.children
    if (firstChild !== undefined) lanes[column] = firstChild
    for (const child of otherChildren) {
      // A fork takes a column right of the node that was free before this row,
      // so a lane that merges here is never reused on the same row.
      let lane = column + 1
      while (lane < lanes.length && ((lanes[lane] ?? null) !== null || (before[lane] ?? null) !== null)) {
        lane += 1
      }
      lanes[lane] = child
      forks.push(lane)
    }

    const reach = Math.max(column, ...merges, ...forks)
    const width = Math.max(before.length, lanes.length)
    let row = ''
    for (let lane = 0; lane < width; lane += 1) {
      const isActive = (before[lane] ?? null) !== null || (lanes[lane] ?? null) !== null
      if (lane === column) row += NODE
      else if (lane < column || lane > reach) row += isActive ? VERTICAL : ' '
      else if (merges.includes(lane)) row += lane === reach ? '┘' : '┴'
      else if (forks.includes(lane)) row += lane === reach ? '┐' : '┬'
      else row += (before[lane] ?? null) !== null ? CROSS : HORIZONTAL
      if (lane < width - 1) row += lane >= column && lane < reach ? HORIZONTAL : ' '
    }
    rows.push(row)

    // Trailing empty lanes cost width for nothing.
    while (lanes.length > 0 && (lanes[lanes.length - 1] ?? null) === null) lanes.pop()
  })

  const graphWidth = Math.max(0, ...rows.map(row => row.trimEnd().length))
  return rows.map(row => row.trimEnd().padEnd(graphWidth))
}
