import type { EngineInterface } from 'claude-code'

import type { Target } from '../types'
import { isFragment } from './parse'

export type DataSource = {
  uuid: string
  name: string
  group: string
  driver: string
  isReadOnly: boolean
}

const APP_LAUNCHER = 'Contents/MacOS/phpstorm'
/** Exits 0 once PhpStorm (an EAP too) is the frontmost app, 1 after 3s. */
const FOCUS_WAIT = [
  '/bin/sh',
  '-c',
  `for _ in $(seq 75); do lsappinfo info -only bundleid "$(lsappinfo front)" | grep -q '"com.jetbrains.PhpStorm' && exit 0; sleep 0.02; done; exit 1`,
]
const SETTLE_MS = 150

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" }

const decode = (text: string) => text.replace(/&(amp|lt|gt|quot|apos);/g, (_, name: string) => ENTITIES[name] ?? '')

const attr = (attrs: string, name: string) => {
  const value = new RegExp(`\\b${name}="([^"]*)"`).exec(attrs)?.[1]
  return value === undefined ? undefined : decode(value)
}

/** The SQL data sources of a PhpStorm `options/dataSources.xml`; Redis left out. */
export function parseDataSources(xml: string): DataSource[] {
  const sources: DataSource[] = []
  for (const [, attrs = '', body = ''] of xml.matchAll(/<data-source\s([^>]*)>([\s\S]*?)<\/data-source>/g)) {
    const uuid = attr(attrs, 'uuid')
    const name = attr(attrs, 'name')
    const driver = /<driver-ref>([^<]*)<\/driver-ref>/.exec(body)?.[1] ?? ''
    if (uuid && name && driver !== 'redis') {
      sources.push({
        uuid,
        name,
        group: attr(attrs, 'group') ?? '',
        driver,
        isReadOnly: attr(attrs, 'read-only') === 'true',
      })
    }
  }
  return sources
}

/**
 * `existing` with `sql` after one blank line, and where the caret goes: the
 * 1-based line and column of offset `end` of `sql` (its end, by default).
 */
export function appendStatement(
  existing: string,
  sql: string,
  end = sql.length,
): { text: string; line: number; column: number } {
  const base = existing.replace(/\s+$/, '')
  const prefix = base === '' ? '' : `${base}\n\n`
  const before = sql.slice(0, end).split('\n')
  return {
    text: `${prefix}${sql}\n`,
    line: prefix.split('\n').length + before.length - 1,
    column: (before.at(-1)?.length ?? 0) + 1,
  }
}

/** The newest PhpStorm config folder (`PhpStorm2026.2`), not PhpStormLight. */
export function newestConfig(names: readonly string[]): string | undefined {
  const versions = names
    .map(name => ({ name, m: /^PhpStorm(\d{4})\.(\d+)$/.exec(name) }))
    .filter(v => v.m !== null)
    .map(v => ({ name: v.name, year: Number(v.m?.[1]), minor: Number(v.m?.[2]) }))
    .sort((a, b) => b.year - a.year || b.minor - a.minor)
  return versions[0]?.name
}

export async function configDir($: EngineInterface): Promise<string | undefined> {
  const home = await $.env.get('HOME')
  if (!home) return undefined
  const base = `${home}/Library/Application Support/JetBrains`
  const entries = await $.fs.list(base).catch(() => [])
  const newest = newestConfig(entries.filter(e => e.kind === 'dir').map(e => e.name))
  return newest === undefined ? undefined : `${base}/${newest}`
}

export async function dataSources($: EngineInterface, dir: string): Promise<DataSource[]> {
  const xml = await $.fs.read(`${dir}/options/dataSources.xml`).catch(() => '')
  return parseDataSources(xml)
}

export function projectSourceFiles(cwd: string): string[] {
  const parts = cwd.replace(/\/+$/, '').split('/')
  return parts.map((_, i) => `${parts.slice(0, parts.length - i).join('/')}/.idea/dataSources.xml`)
}

export async function projectDataSources($: EngineInterface, cwd: string): Promise<DataSource[]> {
  for (const path of projectSourceFiles(cwd)) {
    if (await $.fs.exists(path)) {
      return parseDataSources(await $.fs.read(path).catch(() => ''))
    }
  }
  return []
}

export const consolePath = (dir: string, uuid: string) => `${dir}/consoles/db/${uuid}/console.sql`

/**
 * PhpStorm's launcher: the `phpstorm` option's (an app or the launcher
 * itself), else the one of PhpStorm.app in /Applications or ~/Applications.
 */
export async function launcher($: EngineInterface, option: string): Promise<string | undefined> {
  const set = option.trim().replace(/\/+$/, '')
  if (set !== '') return set.endsWith('.app') ? `${set}/${APP_LAUNCHER}` : set
  const home = await $.env.get('HOME')
  const apps = ['/Applications', ...(home ? [`${home}/Applications`] : [])]
  for (const dir of apps) {
    const path = `${dir}/PhpStorm.app/${APP_LAUNCHER}`
    if (await $.fs.exists(path)) return path
  }
  return undefined
}

/** Appends `sql` to the target's console and opens PhpStorm with the caret at `end`. */
export async function openInConsole(
  $: EngineInterface,
  phpstorm: string,
  target: Target,
  sql: string,
  end: number,
): Promise<boolean> {
  const bin = await launcher($, phpstorm)
  if (bin === undefined) return false
  const existing = (await $.fs.exists(target.path)) ? await $.fs.read(target.path) : ''
  const { text, line, column } = appendStatement(existing, sql, end)
  await $.fs.write(target.path, text)
  const argv = [bin, '--line', String(line), '--column', String(column), target.path]
  const first = await $.process.run(argv, { timeoutMs: 15_000 })
  if (first.exitCode !== 0) return false
  // An open console reloads from disk a moment after PhpStorm's window turns
  // active; the second jump then lands on the appended line.
  await $.process.run(FOCUS_WAIT, { timeoutMs: 5_000 }).catch(() => undefined)
  await $.clock.sleep(SETTLE_MS)
  const second = await $.process.run(argv, { timeoutMs: 15_000 })
  return second.exitCode === 0
}

export const ROUTE_SYSTEM = `You route a SQL block from a Claude Code reply to the PhpStorm data source the user should run it in. The user runs these queries by hand, most often against production, where Claude has no access.

Rules:
- Answer with exactly one data source name from the list, verbatim, or NONE. No other words.
- Tell the service (its group) from the tables in the SQL, the reply text and the working directory.
- If the reply names an environment (local, dev, staging, stage, prod, live, production), use it. If it names none, use the production one (prod, live or production).
- If a service has several production sources, prefer the read-only replica or the one that is not root, unless the reply names another.
- If you cannot tell the service, answer NONE.`

export function routePrompt(sources: readonly DataSource[], cwd: string, reply: string, sql: string): string {
  const list = sources
    .map(s => `- ${s.name} (group ${s.group || 'none'}, ${s.driver}${s.isReadOnly ? ', read-only' : ''})`)
    .join('\n')
  return `Data sources:\n${list}\n\nWorking directory: ${cwd}\n\nReply:\n<reply>\n${reply.slice(0, 8000)}\n</reply>\n\nSQL block:\n<sql>\n${sql}\n</sql>`
}

export const COMPLETE_SYSTEM = `You turn a SQL fragment from a Claude Code reply into the complete statement the user should run. The fragment (for example a replacement WHERE clause, an extra JOIN or ORDER BY) changes a query shown earlier in the reply.

Rules:
- Answer with the complete SQL statement only: no Markdown fence, no explanation.
- Take the query the fragment belongs to from the reply and apply the fragment: replace the clause it replaces, or add it where it goes. Keep everything else, comments and formatting included, unchanged.
- End the statement with ;.
- If the reply holds no query the fragment belongs to, answer NONE.`

export function completePrompt(reply: string, fragment: string): string {
  return `Reply:\n<reply>\n${reply.slice(0, 8000)}\n</reply>\n\nFragment:\n<sql>\n${fragment}\n</sql>`
}

/** The complete statement a model's answer holds, or null for NONE or another fragment. */
export function parseCompletion(answer: string, lang: string): string | null {
  const sql = answer
    .trim()
    .replace(/^```[^\n]*\n([\s\S]*?)\n?```$/, '$1')
    .trim()
  return sql === '' || /^NONE\.?$/i.test(sql) || isFragment(sql, lang) ? null : sql
}

/** The data source a model's answer names, or null for NONE or anything else. */
export function pickSource(answer: string, sources: readonly DataSource[]): DataSource | null {
  const name = answer.trim().replace(/^[`"'*]+|[`"'*.]+$/g, '').trim().toLowerCase()
  return sources.find(s => s.name.toLowerCase() === name) ?? null
}

/** A short stable key for a code block's body (FNV-1a). */
export function blockKey(body: string): string {
  let hash = 0x811c9dc5
  for (let i = 0; i < body.length; i++) {
    hash ^= body.charCodeAt(i)
    hash = Math.imul(hash, 0x01000193)
  }
  return `${(hash >>> 0).toString(16)}:${body.length}`
}
