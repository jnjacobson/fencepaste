/** The button pressed last, by message and key, while its label says how it went. */
export type Feedback = { id: string; ok: boolean } | null

/** A JetBrains IDE with database consoles. */
export type Product = { name: string; binary: string; bundleId: string }

/** An installed IDE and its command-line launcher. */
export type Ide = { product: Product; bin: string }

/**
 * The IDE console a SQL block goes to: its data source's name and file, the IDE,
 * and for a fragment (a lone WHERE clause) the complete statement it gets instead.
 */
export type Target = { name: string; path: string; ide: Ide; sql?: string }

/** Haiku's pick per SQL block (by `blockKey`); null where none fits. */
export type Targets = Record<string, Target | null>

declare module 'claude-code' {
  interface PluginState {
    'fencepaste': { feedback: Feedback; targets: Targets }
  }
}
