import { describe, expect, it } from 'vitest'
import queryFixture from '../../fixtures/ai-eval/queries.json'
import formatFixture from '../../fixtures/ai-eval/format-prompts.json'
import salesLarge from '../../fixtures/sales-large.tsv?raw'
import salesSmall from '../../fixtures/sales.tsv?raw'
import { createEngine } from '../engine/core.js'
import { parseTsv } from '../fixtures/loadSample.js'
import { parseAndValidateAction } from './response.js'
import { executeQuery } from './queryExecutor.js'

function engineFromTsv(tsv) {
  const engine = createEngine(1, 1)
  engine.loadMatrix(parseTsv(tsv))
  return engine
}

function closeEnough(actual, expected) {
  if (typeof expected === 'number') return typeof actual === 'number' && Math.abs(actual - expected) <= 0.01
  return actual === expected
}

describe('AI response safety boundary', () => {
  it('extracts JSON from prose and rejects unknown fields without mutation', () => {
    expect(parseAndValidateAction('Plan:\n```json\n{"type":"query","limit":2}\n```')).toMatchObject({ ok: true })
    expect(parseAndValidateAction('{"action":{"type":"query","limit":2}}')).toMatchObject({ ok: true })
    expect(parseAndValidateAction('{"type":"query","deleteAll":true}')).toMatchObject({ ok: false, error: expect.stringContaining('INVALID_RESPONSE') })
    expect(parseAndValidateAction('not JSON')).toMatchObject({ ok: false, error: expect.stringContaining('INVALID_RESPONSE') })
  })
})

describe('AI golden query plans', () => {
  it('matches every valid golden plan on the large fixture', () => {
    const engine = engineFromTsv(salesLarge)
    const snapshot = engine.getTableSnapshot()
    for (const testCase of queryFixture.cases) {
      if (testCase.expect.error) continue
      const result = executeQuery(snapshot, testCase.plan)
      expect(result.columns, testCase.id).toEqual(testCase.expect.columns)
      expect(result.rowCount, testCase.id).toBe(testCase.expect.rowCount)
      expect(result.truncated, testCase.id).toBe(testCase.expect.truncated)
      const expectedRows = testCase.expect.rows ?? testCase.expect.rowsPreview
      expectedRows.forEach((expectedRow, rowIndex) => expectedRow.forEach((expected, colIndex) => expect(closeEnough(result.rows[rowIndex][colIndex], expected), `${testCase.id} ${rowIndex}:${colIndex}`).toBe(true)))
    }
  })

  it('returns the exact unknown-column error and never accepts mutation plans', () => {
    const engine = engineFromTsv(salesLarge)
    const unknown = queryFixture.cases.find(testCase => testCase.id === 'q14')
    expect(executeQuery(engine.getTableSnapshot(), unknown.plan)).toMatchObject(unknown.expect)
    const mutation = queryFixture.cases.find(testCase => testCase.id === 'q16')
    expect(parseAndValidateAction(JSON.stringify(mutation.plan))).toMatchObject({ ok: false })
    expect(executeQuery(engine.getTableSnapshot(), { type: 'mutation' })).toMatchObject({ error: 'READ_ONLY' })
    expect(executeQuery(engine.getTableSnapshot(), { type: 'query', filters: [{ column: 'Region', op: 'between', value: 'West' }] })).toMatchObject({ error: 'UNKNOWN_OP' })
    expect(executeQuery(engine.getTableSnapshot(), { type: 'query', aggregates: [{ fn: 'median', column: 'Total' }] })).toMatchObject({ error: 'UNKNOWN_FN' })
  })
})

describe('AI golden formatting actions', () => {
  it('applies representative formatting, display values, and one-step undo', () => {
    const engine = engineFromTsv(salesSmall)
    const cleanTable = formatFixture.cases.find(testCase => testCase.id === 'f01').action
    expect(engine.applyFormat(cleanTable).result).toBe('APPLIED')
    expect(engine.getDisplayCell(1, 7).display).toBe('$1,200.00')
    expect(engine.getDisplayCell(5, 8).display).toBe('10%')
    expect(engine.getCell(1, 7).raw).toBe('$1,200.00')
    expect(engine.frozenRows).toBe(1)
    engine.undo()
    expect(engine.getStyle(0, 0).bold).toBe(false)
  })

  it('reports no-op and out-of-range formatting actions', () => {
    const engine = engineFromTsv(salesSmall)
    const outOfRangeColumn = formatFixture.cases.find(testCase => testCase.id === 'f07').action
    const freezeTooMuch = formatFixture.cases.find(testCase => testCase.id === 'f08').action
    expect(engine.applyFormat(outOfRangeColumn).result).toBe('NO_CHANGES')
    expect(engine.applyFormat(freezeTooMuch).error).toBe('OUT_OF_RANGE')
  })

  it('covers the remaining formatting golden actions', () => {
    const byId = id => formatFixture.cases.find(testCase => testCase.id === id).action

    const header = engineFromTsv(salesSmall)
    expect(header.applyFormat(byId('f02')).result).toBe('APPLIED')
    expect(header.getStyle(0, 0)).toMatchObject({ bold: true, bg: '#cce5ff' })

    const currency = engineFromTsv(salesSmall)
    currency.applyFormat(byId('f03'))
    expect(currency.getDisplayCell(6, 7).display).toBe('$79.00')
    expect(currency.getCell(1, 7).raw).toBe('$1,200.00')

    const unfreeze = engineFromTsv(salesSmall)
    expect(unfreeze.applyFormat(byId('f04')).result).toBe('APPLIED')
    expect(unfreeze.frozenRows).toBe(0)

    const body = engineFromTsv(salesSmall)
    body.applyFormat(byId('f05'))
    expect(body.getStyle(1, 6)).toMatchObject({ align: 'right', fontSize: 12 })
    expect(body.getStyle(0, 0).fontSize).toBe(13)

    const clear = engineFromTsv(salesSmall)
    clear.applyFormat(byId('f02'))
    clear.applyFormat(byId('f06'))
    expect(clear.getStyle(0, 0)).toMatchObject({ bold: false, bg: 'white' })

    const totals = engineFromTsv(salesSmall)
    totals.applyFormat(byId('f09'))
    expect(totals.getStyle(32, 0).bg).toBe('#ffff99')
    expect(totals.getStyle(31, 0).bg).toBe('white')

    const noTotals = engineFromTsv(salesSmall)
    noTotals.deleteRow(32)
    expect(noTotals.applyFormat(byId('f10')).result).toBe('NO_CHANGES')
  })
})
