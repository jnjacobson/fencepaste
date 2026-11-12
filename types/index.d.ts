/** The button pressed last, by message and key, while its label says how it went. */
export type Feedback = { id: string; ok: boolean } | null

/**
 * The PhpStorm console a SQL block goes to: its data source's name and file,
 * and for a fragment (a lone WHERE clause) the complete statement it gets instead.
 */
export type Target = { name: string; path: string; sql?: string }

/** Haiku's pick per SQL block (by `blockKey`); null where none fits. */
export type Targets = Record<string, Target | null>

declare module 'claude-code' {
  interface PluginState {
    'fencepaste': { feedback: Feedback; targets: Targets }
  }
}
