export type Segment =
  | { kind: 'prose'; text: string }
  | { kind: 'code'; lang: string; body: string; indent: number }

export const SQL_LANGS: ReadonlySet<string> = new Set([
  'sql',
  'mysql',
  'mariadb',
  'postgres',
  'postgresql',
  'pgsql',
  'psql',
  'sqlite',
  'plsql',
  'tsql',
])

const OPEN = /^([ \t]*)(`{3,}|~{3,})(.*)$/
const CLOSE = /^[ \t]*(`{3,}|~{3,})[ \t]*$/

/**
 * Splits a reply's markdown into prose and closed, non-empty code fences.
 * An unclosed fence (still streaming) and an empty one stay prose.
 */
export function splitFences(markdown: string): Segment[] {
  const lines = markdown.split('\n')
  const segments: Segment[] = []
  let prose: string[] = []

  const flushProse = () => {
    if (prose.length > 0) {
      segments.push({ kind: 'prose', text: prose.join('\n') })
      prose = []
    }
  }

  let i = 0
  while (i < lines.length) {
    const line = lines[i] ?? ''
    const open = OPEN.exec(line)
    const marker = open?.[2] ?? ''
    const info = open?.[3] ?? ''

    if (!open || (marker.startsWith('`') && info.includes('`'))) {
      prose.push(line)
      i++
      continue
    }

    const close = findClose(lines, i + 1, marker)
    if (close === -1) {
      prose.push(...lines.slice(i))
      break
    }

    const indent = (open[1] ?? '').length
    const body = lines
      .slice(i + 1, close)
      .map(l => dedent(l, indent))
      .join('\n')

    if (body.trim() === '') {
      prose.push(...lines.slice(i, close + 1))
    } else {
      flushProse()
      const lang = (info.trim().split(/\s+/)[0] ?? '').toLowerCase()
      segments.push({ kind: 'code', lang, body, indent })
    }
    i = close + 1
  }

  flushProse()
  return segments
}

function findClose(lines: string[], from: number, marker: string): number {
  for (let j = from; j < lines.length; j++) {
    const m = CLOSE.exec(lines[j] ?? '')
    const run = m?.[1]
    if (run && run[0] === marker[0] && run.length >= marker.length) {
      return j
    }
  }
  return -1
}

function dedent(line: string, indent: number): string {
  let k = 0
  while (k < indent && (line[k] === ' ' || line[k] === '\t')) k++
  return line.slice(k)
}

/** A fence around `body` that no line of `body` can close. */
export function fence(lang: string, body: string): string {
  let longest = 2
  for (const m of body.matchAll(/^[ \t]*(`+)/gm)) {
    longest = Math.max(longest, m[1]?.length ?? 0)
  }
  const marker = '`'.repeat(longest + 1)
  return `${marker}${lang}\n${body}\n${marker}`
}

type Scan = { cuts: number[]; code: string }

/**
 * Walks SQL once: `cuts` are the offsets just past each top-level `;`, and
 * `code` is the source with strings, quoted identifiers, comments and
 * dollar-quoted bodies blanked out, for keyword checks.
 */
function scan(src: string, hashComments: boolean): Scan {
  const cuts: number[] = []
  let code = ''
  const n = src.length
  let i = 0

  while (i < n) {
    const c = src[i]
    const d = src[i + 1]

    if ((c === '-' && d === '-') || (hashComments && c === '#')) {
      const end = src.indexOf('\n', i)
      i = end === -1 ? n : end
      code += ' '
      continue
    }
    if (c === '/' && d === '*') {
      const end = src.indexOf('*/', i + 2)
      i = end === -1 ? n : end + 2
      code += ' '
      continue
    }
    if (c === "'" || c === '"' || c === '`') {
      i = skipQuoted(src, i, c)
      code += ' '
      continue
    }
    if (c === '$') {
      const tag = /^\$(?:[A-Za-z_][A-Za-z0-9_]*)?\$/.exec(src.slice(i, i + 64))?.[0]
      if (tag) {
        const end = src.indexOf(tag, i + tag.length)
        i = end === -1 ? n : end + tag.length
        code += ' '
        continue
      }
    }
    if (c === ';') {
      cuts.push(i + 1)
    }
    code += c
    i++
  }

  return { cuts, code }
}

function skipQuoted(src: string, i: number, quote: string): number {
  let j = i + 1
  while (j < src.length) {
    const c = src[j]
    if (c === '\\' && quote !== '`') {
      j += 2
      continue
    }
    if (c === quote) {
      if (src[j + 1] === quote) {
        j += 2
        continue
      }
      return j + 1
    }
    j++
  }
  return src.length
}

const hashes = (lang: string) => lang === 'mysql' || lang === 'mariadb'

/** The offset just past a statement's last top-level `;`, or its end when it has none. */
export function statementEnd(sql: string, lang = 'sql'): number {
  const { cuts } = scan(sql, hashes(lang))
  return cuts.at(-1) ?? sql.trimEnd().length
}

const STATEMENT =
  /^\s*(\(|(SELECT|WITH|INSERT|UPDATE|DELETE|REPLACE|MERGE|UPSERT|CREATE|ALTER|DROP|TRUNCATE|RENAME|GRANT|REVOKE|SHOW|DESCRIBE|DESC|EXPLAIN|ANALYZE|OPTIMIZE|CHECK|REPAIR|SET|RESET|USE|BEGIN|START|COMMIT|ROLLBACK|SAVEPOINT|RELEASE|LOCK|UNLOCK|CALL|EXEC|EXECUTE|DO|PREPARE|DEALLOCATE|DECLARE|VALUES|TABLE|COPY|VACUUM|REINDEX|CLUSTER|COMMENT|KILL|FLUSH|LOAD|HANDLER|PRAGMA|ATTACH|DETACH|LISTEN|NOTIFY|DELIMITER)\b)/i

/** Whether `sql` is a piece of a statement, such as a lone WHERE clause. */
export function isFragment(sql: string, lang = 'sql'): boolean {
  const { code } = scan(sql, hashes(lang))
  return code.trim() !== '' && !STATEMENT.test(code)
}

function hasCode(piece: string, hashComments: boolean): boolean {
  return scan(piece, hashComments).code.replace(/;/g, '').trim() !== ''
}

/**
 * The statements of a SQL block, each with its `;` and the comments that
 * lead it; `null` when the block holds fewer than two, or when its `;`
 * do not end statements (MySQL `DELIMITER`, a routine body in BEGIN … END).
 */
export function splitSql(src: string, lang = 'sql'): string[] | null {
  const hashComments = hashes(lang)
  const { cuts, code } = scan(src, hashComments)

  if (/^[ \t]*DELIMITER\s/im.test(code)) return null
  if (
    /\bCREATE\b[^;]*?\b(PROCEDURE|FUNCTION|TRIGGER|EVENT)\b/i.test(code) &&
    /\bBEGIN\b/i.test(code)
  ) {
    return null
  }

  const trailing = hashComments ? /^[ \t]*(--|#)[^\n]*/ : /^[ \t]*--[^\n]*/
  const pieces: string[] = []
  let start = 0
  for (const cut of cuts) {
    const end = cut + (trailing.exec(src.slice(cut))?.[0].length ?? 0)
    pieces.push(src.slice(start, end))
    start = end
  }
  pieces.push(src.slice(start))

  const statements: string[] = []
  let lead = ''
  for (const piece of pieces) {
    const text = piece.trim()
    if (text === '') continue
    if (hasCode(text, hashComments)) {
      statements.push(lead ? `${lead}\n${text}` : text)
      lead = ''
    } else {
      const comment = text.replace(/;$/, '').trim()
      if (comment) lead = lead ? `${lead}\n${comment}` : comment
    }
  }
  if (lead) {
    const last = statements.pop()
    statements.push(last === undefined ? lead : `${last}\n${lead}`)
  }

  return statements.length >= 2 ? statements : null
}
