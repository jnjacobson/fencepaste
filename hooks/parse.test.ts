import { describe, expect, test } from 'claude-code/testing'

import { fence, isFragment, splitFences, splitSql, statementEnd } from './parse'

const codes = (md: string) =>
  splitFences(md).flatMap(s => (s.kind === 'code' ? [{ lang: s.lang, body: s.body }] : []))

describe('splitFences', () => {
  test('finds backtick and tilde fences between prose', () => {
    const md = 'Intro\n\n```SQL\nSELECT 1;\n```\n\nMiddle\n\n~~~bash\nls -la\n~~~\nEnd'
    expect(codes(md)).toEqual([
      { lang: 'sql', body: 'SELECT 1;' },
      { lang: 'bash', body: 'ls -la' },
    ])
    expect(splitFences(md).map(s => s.kind)).toEqual(['prose', 'code', 'prose', 'code', 'prose'])
  })

  test('strips the indentation of a fence inside a list', () => {
    const md = '1. Run:\n   ```sql\n   SELECT a\n     FROM t;\n   ```\n2. Done'
    expect(codes(md)).toEqual([{ lang: 'sql', body: 'SELECT a\n  FROM t;' }])
  })

  test('leaves an unclosed fence as prose', () => {
    const md = 'Text\n```sql\nSELECT 1;'
    expect(splitFences(md)).toEqual([{ kind: 'prose', text: md }])
  })

  test('leaves an empty fence as prose', () => {
    expect(codes('```sql\n\n```')).toEqual([])
  })

  test('ignores inline code and 4-space indented blocks', () => {
    expect(codes('Use `SELECT 1` here.\n\n    SELECT 2;\n')).toEqual([])
  })

  test('a longer fence holds a shorter one', () => {
    const md = '````md\n```sql\nSELECT 1;\n```\n````'
    expect(codes(md)).toEqual([{ lang: 'md', body: '```sql\nSELECT 1;\n```' }])
  })

  test('a fence without a language has an empty lang', () => {
    expect(codes('```\nplain\n```')).toEqual([{ lang: '', body: 'plain' }])
  })
})

describe('fence', () => {
  test('picks a marker no line of the body closes', () => {
    expect(fence('sql', 'SELECT 1;')).toBe('```sql\nSELECT 1;\n```')
    expect(fence('md', '```x\n```')).toBe('````md\n```x\n```\n````')
  })
})

describe('splitSql', () => {
  test('splits at top-level semicolons, keeping each ;', () => {
    expect(splitSql('SELECT 1;\nSELECT 2;\n')).toEqual(['SELECT 1;', 'SELECT 2;'])
  })

  test('returns null for a single statement', () => {
    expect(splitSql('SELECT 1;')).toBeNull()
    expect(splitSql('SELECT 1')).toBeNull()
  })

  test('ignores semicolons in strings, identifiers and comments', () => {
    const sql = [
      "SELECT 'a;b', \"c;d\", `e;f` FROM t; -- trailing; comment",
      '/* block; comment */',
      "SELECT 'it''s; fine';",
    ].join('\n')
    expect(splitSql(sql)).toEqual([
      "SELECT 'a;b', \"c;d\", `e;f` FROM t; -- trailing; comment",
      "/* block; comment */\nSELECT 'it''s; fine';",
    ])
  })

  test('handles a MySQL backslash escape', () => {
    expect(splitSql("SELECT 'it\\'s;';\nSELECT 2;", 'mysql')).toEqual([
      "SELECT 'it\\'s;';",
      'SELECT 2;',
    ])
  })

  test('treats # as a comment in MySQL only', () => {
    expect(splitSql('# note; here\nSELECT 1;\nSELECT 2;', 'mysql')).toEqual([
      '# note; here\nSELECT 1;',
      'SELECT 2;',
    ])
  })

  test('keeps dollar-quoted bodies whole', () => {
    const fn = 'CREATE FUNCTION f() RETURNS int AS $$\nBEGIN\n  RETURN 1;\nEND;\n$$ LANGUAGE plpgsql;'
    expect(splitSql(`${fn}\nSELECT f();`, 'postgresql')).toEqual([fn, 'SELECT f();'])
    expect(splitSql('SELECT $1; SELECT $tag$a;b$tag$;')).toEqual(['SELECT $1;', 'SELECT $tag$a;b$tag$;'])
  })

  test('gives leading comment lines to the next statement', () => {
    const sql = '-- count users\nSELECT COUNT(*) FROM users;\n\n-- and posts\nSELECT COUNT(*) FROM posts;'
    expect(splitSql(sql)).toEqual([
      '-- count users\nSELECT COUNT(*) FROM users;',
      '-- and posts\nSELECT COUNT(*) FROM posts;',
    ])
  })

  test('keeps a last statement without ; and a trailing comment', () => {
    expect(splitSql('SELECT 1;\nSELECT 2')).toEqual(['SELECT 1;', 'SELECT 2'])
    expect(splitSql('SELECT 1;\nSELECT 2;\n-- done')).toEqual(['SELECT 1;', 'SELECT 2;\n-- done'])
  })

  test('drops empty statements', () => {
    expect(splitSql('SELECT 1;;\n;SELECT 2;')).toEqual(['SELECT 1;', 'SELECT 2;'])
  })

  test('does not split a DELIMITER block', () => {
    expect(splitSql('DELIMITER //\nCREATE PROCEDURE p() BEGIN SELECT 1; END //\nDELIMITER ;')).toBeNull()
  })

  test('does not split a BEGIN … END routine body', () => {
    const sql = 'CREATE TRIGGER t BEFORE INSERT ON x FOR EACH ROW\nBEGIN\n  SET NEW.a = 1;\n  SET NEW.b = 2;\nEND;'
    expect(splitSql(sql, 'mysql')).toBeNull()
  })

  test('splits a transaction', () => {
    expect(splitSql('BEGIN;\nUPDATE t SET a = 1;\nCOMMIT;')).toEqual(['BEGIN;', 'UPDATE t SET a = 1;', 'COMMIT;'])
  })
})

describe('statementEnd', () => {
  test('lands just past the last top-level ;', () => {
    const sql = "SELECT 'a;b'\n  FROM t; -- done; really"
    expect(sql.slice(0, statementEnd(sql))).toBe("SELECT 'a;b'\n  FROM t;")
  })

  test('lands at the end of a statement without ;', () => {
    expect(statementEnd('SELECT 1\n')).toBe(8)
  })
})

describe('isFragment', () => {
  test('a lone clause is a fragment', () => {
    expect(isFragment('WHERE created_at >= CURDATE()\n  AND x < 1')).toBe(true)
    expect(isFragment('-- last week\nAND b = 2')).toBe(true)
    expect(isFragment('ORDER BY id DESC')).toBe(true)
  })

  test('a statement is not, whatever leads it', () => {
    expect(isFragment('select 1')).toBe(false)
    expect(isFragment('-- note\n/* x */ WITH a AS (SELECT 1) SELECT * FROM a;')).toBe(false)
    expect(isFragment('(SELECT 1) UNION (SELECT 2)')).toBe(false)
    expect(isFragment('# note\nSHOW TABLES', 'mysql')).toBe(false)
    expect(isFragment('-- only a comment')).toBe(false)
  })
})
