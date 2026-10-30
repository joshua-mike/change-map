/** A run of changed lines, 1-based and inclusive. A pure removal is one line: the one before the gap. */
export type LineRange = {
  start: number
  end: number
}

export type ChangedFile = {
  /** Lowercase forward-slash absolute path: the list key. */
  key: string
  absPath: string
  /** Relative to the working directory, forward slashes. */
  relPath: string
  /** 1-based order of the first change. */
  order: number
  /** How many times the file was found changed. */
  edits: number
  /** True when this session created the file. */
  isNew: boolean
  /** The lines the session changed, in file order; empty for a new file or when unknown. */
  ranges: LineRange[]
}

declare module 'claude-code' {
  interface PluginState {
    'change-map': {
      files: Shaped<ChangedFile[]>
    }
  }
}
