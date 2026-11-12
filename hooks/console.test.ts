import { describe, expect, test } from 'claude-code/testing'

import { appendStatement, blockKey, newestConfig, parseCompletion, parseDataSources, pickSource } from './console'

const XML = `<?xml version="1.0" encoding="UTF-8"?>
<project version="4">
  <component name="DataSourceManagerImpl" format="xml" multifile-model="true">
    <data-source source="LOCAL" name="shop - prod replica/ro" read-only="true" group="shop" uuid="u1">
      <driver-ref>mariadb</driver-ref>
    </data-source>
    <data-source source="LOCAL" name="cache - live REDIS" group="cache" uuid="u2">
      <driver-ref>redis</driver-ref>
    </data-source>
    <data-source source="LOCAL" name="a &amp; b" group="x" uuid="u3">
      <driver-ref>postgresql</driver-ref>
    </data-source>
  </component>
</project>`

describe('parseDataSources', () => {
  test('reads SQL sources, leaves Redis out, decodes entities', () => {
    expect(parseDataSources(XML)).toEqual([
      { uuid: 'u1', name: 'shop - prod replica/ro', group: 'shop', driver: 'mariadb', isReadOnly: true },
      { uuid: 'u3', name: 'a & b', group: 'x', driver: 'postgresql', isReadOnly: false },
    ])
  })

  test('reads nothing from an empty file', () => {
    expect(parseDataSources('')).toEqual([])
  })
})

describe('appendStatement', () => {
  test('starts an empty console on line 1', () => {
    expect(appendStatement('', 'SELECT 1;')).toEqual({ text: 'SELECT 1;\n', line: 1, column: 10 })
    expect(appendStatement('\n\n', 'SELECT 1;')).toEqual({ text: 'SELECT 1;\n', line: 1, column: 10 })
  })

  test('adds after one blank line, trailing blank lines folded', () => {
    expect(appendStatement('SELECT 1;\nSELECT 2;\n\n\n', 'SELECT 3;')).toEqual({
      text: 'SELECT 1;\nSELECT 2;\n\nSELECT 3;\n',
      line: 4,
      column: 10,
    })
  })

  test('puts the caret at `end`, on a later line of the statement', () => {
    const sql = '-- note\nSELECT a\n  FROM t; -- done'
    expect(appendStatement('SELECT 0;', sql, sql.indexOf(';') + 1)).toMatchObject({ line: 5, column: 10 })
  })
})

describe('newestConfig', () => {
  test('picks the newest PhpStorm, never PhpStormLight', () => {
    expect(
      newestConfig(['PhpStorm2025.3', 'PhpStorm2026.2', 'PhpStormLight2026.3', 'PhpStorm2026.10', 'IntelliJIdea2026.2']),
    ).toBe('PhpStorm2026.10')
    expect(newestConfig(['WebStorm2026.1'])).toBeUndefined()
  })
})

describe('pickSource', () => {
  const sources = parseDataSources(XML)

  test('matches the name verbatim, ignoring case, quotes and a full stop', () => {
    expect(pickSource('shop - prod replica/ro', sources)?.uuid).toBe('u1')
    expect(pickSource(' `SHOP - Prod Replica/RO`. ', sources)?.uuid).toBe('u1')
  })

  test('answers null for NONE or a name not listed', () => {
    expect(pickSource('NONE', sources)).toBeNull()
    expect(pickSource('cache - live REDIS', sources)).toBeNull()
  })
})

describe('blockKey', () => {
  test('is stable and tells bodies apart', () => {
    expect(blockKey('SELECT 1;')).toBe(blockKey('SELECT 1;'))
    expect(blockKey('SELECT 1;')).not.toBe(blockKey('SELECT 2;'))
  })
})

describe('parseCompletion', () => {
  test('takes the statement, with or without a fence', () => {
    expect(parseCompletion('SELECT 1\nWHERE a = 1;', 'sql')).toBe('SELECT 1\nWHERE a = 1;')
    expect(parseCompletion('```sql\nSELECT 1;\n```\n', 'sql')).toBe('SELECT 1;')
  })

  test('answers null for NONE or another fragment', () => {
    expect(parseCompletion('NONE', 'sql')).toBeNull()
    expect(parseCompletion('WHERE a = 1', 'sql')).toBeNull()
    expect(parseCompletion('', 'sql')).toBeNull()
  })
})
