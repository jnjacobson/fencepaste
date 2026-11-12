import type { On } from 'claude-code'
import { expect, mock, test } from 'claude-code/testing'

import { COMPLETE_SYSTEM } from './console'

const message = (text: string) =>
  ({
    plugin: 'fencepaste',
    component: 'AssistantMessage',
    requestId: 'm1',
    props: { text, isFirstOfReply: true },
  }) as const

const SQL = 'Two queries:\n\n```sql\n-- users\nSELECT 1;\nSELECT 2;\n```\n\nAnd a script:\n\n```bash\nls -la\n```'

test('one button per SQL statement and one per other block; a press copies it', async ($, on) => {
  const copied: string[] = []
  const clock = mock.clock(on)
  on('ui.copy', (_, e) => {
    copied.push(e.text)
    return { value: { isCopied: true } }
  })

  const ui = await $.ui.mount({ ...message(SQL), surface: 'terminal' })
  const label = async (key: string) => (await ui.find({ key }))?.text

  expect((await ui.findAll({ type: 'Button' })).map(b => b.key)).toEqual(['copy-1-0', 'copy-1-1', 'copy-3-0'])
  expect(await ui.find({ type: 'Text', text: 'sql 1/2' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: 'bash' })).toBeDefined()
  // Drawn as Code: an unknown language gets no second label from the markdown renderer.
  expect((await ui.find({ type: 'Code', text: 'ls -la' }))?.text).toBe('ls -la')
  expect(await ui.find({ type: 'Markdown', text: '```' })).toBeUndefined()

  await ui.press({ key: 'copy-1-0' })
  expect(await label('copy-1-0')).toBe('copied ✓')
  expect(await label('copy-1-1')).toBe('copy')

  // Another press moves the mark and restarts the timer.
  await clock.advance(1500)
  await ui.press({ key: 'copy-3-0' })
  expect(copied).toEqual(['-- users\nSELECT 1;', 'ls -la'])
  expect(await label('copy-1-0')).toBe('copy')
  expect(await label('copy-3-0')).toBe('copied ✓')

  await clock.advance(1500)
  expect(await label('copy-3-0')).toBe('copied ✓')
  await clock.advance(500)
  expect(await label('copy-3-0')).toBe('copy')
  await ui.unmount()
})

test('a failed copy says so on the button', async ($, on) => {
  mock.clock(on)
  on('ui.copy', () => ({ value: { isCopied: false, reason: 'no-clipboard' } }))

  const ui = await $.ui.mount({ ...message('```js\nx()\n```'), surface: 'terminal' })
  await ui.press({ key: 'copy-0-0' })
  expect((await ui.find({ key: 'copy-0-0' }))?.text).toBe('copy failed')
  await ui.unmount()
})

test('no buttons without a closed fence, or off the terminal', async $ => {
  for (const text of ['Just `inline` code.', 'Streaming:\n```sql\nSELECT 1;']) {
    const ui = await $.ui.mount({ ...message(text), surface: 'terminal' })
    expect(await ui.findAll({ type: 'Button' })).toHaveLength(0)
    await ui.unmount()
  }

  for (const surface of ['desktop', 'vscode', 'mobile'] as const) {
    const ui = await $.ui.mount({ ...message(SQL), surface })
    expect(await ui.findAll({ type: 'Button' })).toHaveLength(0)
    await ui.unmount()
  }
})

const HOME = '/Users/me'
const DIR = `${HOME}/Library/Application Support/JetBrains/PhpStorm2026.2`
const CONSOLE = `${DIR}/consoles/db/u1/console.sql`
const SOURCE = 'shop - prod replica/ro'
const BIN = '/Applications/PhpStorm.app/Contents/MacOS/phpstorm'
const launch = (line: number, column: number, bin = BIN) =>
  [bin, '--line', String(line), '--column', String(column), CONSOLE]

/** Stands in for PhpStorm's config and launcher, Haiku and the clipboard. */
function phpstorm(on: On, completion = 'NONE') {
  const xml =
    `<data-source source="LOCAL" name="${SOURCE}" read-only="true" group="shop" uuid="u1">` +
    '<driver-ref>mariadb</driver-ref></data-source>'
  const files: Record<string, string> = {
    [`${DIR}/options/dataSources.xml`]: xml,
    [CONSOLE]: 'SELECT 0;\n',
    [BIN]: '',
  }
  const prompts: { system: string; prompt: string }[] = []
  const runs: (readonly string[])[] = []
  const copied: string[] = []

  on('turn.complete', () => ({ text: '' }))
  on('env.get', () => ({ value: HOME }))
  on('session.cwd', () => ({ value: '/repos/shop' }))
  on('fs.list', () => ({
    value: [
      { name: 'PhpStorm2025.3', kind: 'dir', size: 0, mtimeMs: 0, isLink: false },
      { name: 'PhpStorm2026.2', kind: 'dir', size: 0, mtimeMs: 0, isLink: false },
    ],
  }))
  on('fs.read', (_, e) => ({ value: files[e.path] ?? '' }))
  on('fs.exists', (_, e) => ({ value: e.path in files }))
  on('fs.write', (_, e) => {
    files[e.path] = e.text
    return { value: undefined }
  })
  on('model.complete', (_, e) => {
    prompts.push({ system: String(e.system), prompt: String(e.prompt) })
    return {
      value: {
        isAnswered: true,
        text: e.system === COMPLETE_SYSTEM ? completion : SOURCE,
        usage: { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
      },
    }
  })
  on('process.run', (_, e) => {
    runs.push(e.argv)
    return { value: { exitCode: 0, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  on('ui.copy', (_, e) => {
    copied.push(e.text)
    return { value: { isCopied: true } }
  })
  return { files, prompts, runs, copied }
}

test('Haiku routes a reply’s SQL to a PhpStorm console; a press appends and opens it', async ($, on) => {
  const clock = mock.clock(on)
  const { files, prompts, runs } = phpstorm(on)

  const reply = 'Run this on prod:\n\n```sql\nSELECT 1;\nSELECT 2;\n```'
  await $.turn.complete({ answer: reply, durationMs: 1, isAborted: false, turnId: 't1', reason: 'answer' })
  await clock.advance(0)

  expect(prompts).toHaveLength(1)
  expect(prompts[0]?.prompt).toContain('/repos/shop')

  const ui = await $.ui.mount({ ...message(reply), surface: 'terminal' })
  expect((await ui.find({ key: 'console-1-1' }))?.text).toBe(`▸ ${SOURCE}`)

  const pressing = ui.press({ key: 'console-1-1' })
  for (let i = 0; i < 10 && runs.length < 3; i++) await clock.advance(200)
  await pressing
  expect(files[CONSOLE]).toBe('SELECT 0;\n\nSELECT 2;\n')
  expect(runs).toHaveLength(3)
  expect([runs[0], runs[2]]).toEqual([launch(3, 10), launch(3, 10)])
  expect(runs[1]?.join(' ')).toContain('lsappinfo front')
  expect((await ui.find({ key: 'console-1-1' }))?.text).toBe('opened ✓')
  await ui.unmount()

  // A block already routed is not sent to Haiku again.
  await $.turn.complete({ answer: reply, durationMs: 1, isAborted: false, turnId: 't2', reason: 'answer' })
  await clock.advance(0)
  expect(prompts).toHaveLength(1)
})

const OWN_APP = { options: { phpstorm: '/Users/me/Apps/PhpStorm.app/' } }

test('a fragment goes to the console as the complete query Haiku builds; copy keeps the fragment', OWN_APP, async ($, on) => {
  const clock = mock.clock(on)
  const full = 'SELECT COUNT(*) FROM t\nWHERE b = 2;'
  const { files, prompts, runs, copied } = phpstorm(on, `\`\`\`sql\n${full}\n\`\`\``)

  const reply = 'Count:\n\n```sql\nSELECT COUNT(*) FROM t\nWHERE a = 1;\n```\n\nFor last week:\n\n```sql\nWHERE b = 2\n```'
  await $.turn.complete({ answer: reply, durationMs: 1, isAborted: false, turnId: 't1', reason: 'answer' })
  await clock.advance(0)

  // Only the fragment is completed, and it is routed as the complete query.
  expect(prompts.filter(p => p.system === COMPLETE_SYSTEM)).toHaveLength(1)
  expect(prompts.some(p => p.system !== COMPLETE_SYSTEM && p.prompt.includes(`<sql>\n${full}\n</sql>`))).toBe(true)

  const ui = await $.ui.mount({ ...message(reply), surface: 'terminal' })
  await ui.press({ key: 'copy-3-0' })
  const pressing = ui.press({ key: 'console-3-0' })
  for (let i = 0; i < 10 && runs.length < 3; i++) await clock.advance(200)
  await pressing
  expect(copied).toEqual(['WHERE b = 2', full])
  expect(files[CONSOLE]).toBe(`SELECT 0;\n\n${full}\n`)
  // The phpstorm option names the app.
  expect(runs[0]).toEqual(launch(4, 13, '/Users/me/Apps/PhpStorm.app/Contents/MacOS/phpstorm'))
  await ui.unmount()
})

test('without PhpStorm the console button fails and leaves the console as it was', async ($, on) => {
  const clock = mock.clock(on)
  const { files, runs } = phpstorm(on)
  delete files[BIN]

  const reply = '```sql\nSELECT 1;\n```'
  await $.turn.complete({ answer: reply, durationMs: 1, isAborted: false, turnId: 't1', reason: 'answer' })
  await clock.advance(0)

  const ui = await $.ui.mount({ ...message(reply), surface: 'terminal' })
  await ui.press({ key: 'console-0-0' })
  expect((await ui.find({ key: 'console-0-0' }))?.text).toBe('console failed')
  expect(files[CONSOLE]).toBe('SELECT 0;\n')
  expect(runs).toEqual([])
  await ui.unmount()
})

test('no console button until a reply’s SQL is routed', async $ => {
  const ui = await $.ui.mount({ ...message('```sql\nSELECT 1;\n```'), surface: 'terminal' })
  expect((await ui.findAll({ type: 'Button' })).map(b => b.key)).toEqual(['copy-0-0'])
  await ui.unmount()
})
