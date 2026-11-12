import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, RenderSurface, Timer } from 'claude-code'

import type { Target, Targets } from '../types'
import {
  COMPLETE_SYSTEM,
  ROUTE_SYSTEM,
  blockKey,
  completePrompt,
  configDir,
  consolePath,
  dataSources,
  findIde,
  openInConsole,
  parseCompletion,
  pickSource,
  projectDataSources,
  routePrompt,
} from './console'
import { SQL_LANGS, fence, isFragment, splitFences, splitSql, statementEnd } from './parse'

const FEEDBACK_MS = 2000

const feedback = atom({ plugin: 'fencepaste', key: 'feedback' } as const, null)
const targets = atom({ plugin: 'fencepaste', key: 'targets' } as const, {} as Targets)

const sqlBlocks = (text: string) =>
  splitFences(text).flatMap(s => (s.kind === 'code' && SQL_LANGS.has(s.lang) ? [{ lang: s.lang, body: s.body }] : []))

/** Haiku's complete statement for a fragment, from the query in the reply it changes. */
async function complete($: EngineInterface, reply: string, fragment: string, lang: string): Promise<string | null> {
  const answer = await $.model.complete({
    model: 'haiku',
    system: COMPLETE_SYSTEM,
    prompt: completePrompt(reply, fragment),
    maxTokens: 2000,
  })
  return answer.isAnswered ? parseCompletion(answer.text, lang) : null
}

/** Asks Haiku which IDE console each new SQL block of a reply belongs in. */
async function route($: EngineInterface, reply: string, ideOption: string) {
  const known = await read($, targets)
  const blocks = sqlBlocks(reply).filter(
    (block, i, all) => !(blockKey(block.body) in known) && all.findIndex(b => b.body === block.body) === i,
  )
  if (blocks.length === 0) return

  const ide = await findIde($, ideOption)
  if (ide === undefined) return
  const dir = await configDir($, ide.product)
  if (dir === undefined) return
  const cwd = await $.session.cwd()
  const sources = [...(await projectDataSources($, cwd)), ...(await dataSources($, dir))]
  if (sources.length === 0) return

  await Promise.all(
    blocks.map(async ({ lang, body }) => {
      const sql = splitSql(body, lang) === null && isFragment(body, lang) ? await complete($, reply, body, lang) : null
      const answer = await $.model.complete({
        model: 'haiku',
        system: ROUTE_SYSTEM,
        prompt: routePrompt(sources, cwd, reply, sql ?? body),
        maxTokens: 50,
      })
      if (!answer.isAnswered) return
      const source = pickSource(answer.text, sources)
      const target: Target | null = source && {
        name: source.name,
        path: consolePath(dir, source.uuid),
        ide,
        ...(sql === null ? {} : { sql }),
      }
      await update($, targets, all => ({ ...all, [blockKey(body)]: target }))
    }),
  )
}

let reset: Timer | undefined

/** Marks a button's outcome on its label for FEEDBACK_MS. */
async function flash($: EngineInterface, id: string, ok: boolean) {
  await update($, feedback, () => ({ id, ok }))
  reset?.cancel()
  reset = $.clock.after(FEEDBACK_MS, () => void update($, feedback, () => null))
}

export const register: Register = (on, options) => {
  const ideOption = typeof options.ide === 'string' ? options.ide : ''

  on('turn.complete', async ($, e, next) => {
    const result = await next(e)
    if (e.agentId === undefined && e.reason === 'answer' && sqlBlocks(e.answer).length > 0) {
      // After the turn has ended, so routing never holds it up.
      $.clock.after(0, () => void route($, e.answer, ideOption).catch(() => undefined))
    }
    return result
  })

  on('ui.render', { component: 'AssistantMessage' }, async ($, e, next) => {
    if (e.surface !== 'terminal' || e.props.isSummary) {
      return next(e)
    }

    const segments = splitFences(e.props.text)
    if (!segments.some(s => s.kind === 'code')) {
      return next(e)
    }

    const { Box, Text, Button, Code } = $.ui.resolve(e)
    const last = await read($, feedback)
    const routes = await read($, targets)

    // The first engine node keeps the reply's bullet; later ones go without.
    let isFirst = e.props.isFirstOfReply
    const engine = (text: string) => {
      const props = { ...e.props, text, isFirstOfReply: isFirst }
      isFirst = false
      return next({ ...e, props })
    }

    const copy = async (id: string, text: string, surface: RenderSurface) => {
      const { isCopied } = await $.ui.copy({ text, surface })
      await flash($, id, isCopied)
    }

    const toConsole = async (id: string, text: string, lang: string, target: Target, surface: RenderSurface) => {
      await $.ui.copy({ text, surface })
      const ok = await openInConsole($, target, text, statementEnd(text, lang)).catch(() => false)
      await flash($, id, ok)
    }

    const labelOf = (id: string, idle: string, done: string, failed: string) =>
      last?.id === id ? (last.ok ? done : failed) : idle

    const children = []
    for (const [s, segment] of segments.entries()) {
      if (segment.kind === 'prose') {
        if (segment.text.trim() !== '') {
          children.push(await engine(segment.text))
        }
        continue
      }

      const { lang, body, indent } = segment
      const isSql = SQL_LANGS.has(lang)
      const blocks = (isSql && splitSql(body, lang)) || [body]
      const target = isSql ? routes[blockKey(body)] : undefined

      for (const [b, block] of blocks.entries()) {
        const copyKey = `copy-${s}-${b}`
        const consoleKey = `console-${s}-${b}`
        const copyId = `${e.requestId}:${copyKey}`
        const consoleId = `${e.requestId}:${consoleKey}`
        const copyLabel = labelOf(copyId, 'copy', 'copied ✓', 'copy failed')
        const consoleLabel = target && labelOf(consoleId, `▸ ${target.name}`, 'opened ✓', 'console failed')
        const label = blocks.length > 1 ? `${lang} ${b + 1}/${blocks.length}` : lang || 'code'
        const source = fence(lang, block)
        const statement = (blocks.length === 1 && target?.sql) || block
        const header = (
          <Box flexDirection="row" gap={1}>
            <Text dimColor>{label}</Text>
            <Button
              key={copyKey}
              label={copyLabel}
              dimColor={copyLabel === 'copy'}
              onPress={press => copy(copyId, block, press.surface)}
            />
            {target && consoleLabel && (
              <Button
                key={consoleKey}
                label={consoleLabel}
                dimColor={consoleLabel.startsWith('▸')}
                onPress={press => toConsole(consoleId, statement, lang, target, press.surface)}
              />
            )}
          </Box>
        )

        if (isFirst) {
          children.push(<Box paddingLeft={2 + indent}>{header}</Box>, await engine(source))
        } else {
          children.push(
            <Box flexDirection="column" marginTop={1} paddingLeft={2 + indent}>
              {header}
              <Code source={block} language={lang || undefined} />
            </Box>,
          )
        }
      }
    }

    return <Box flexDirection="column">{children}</Box>
  })
}
