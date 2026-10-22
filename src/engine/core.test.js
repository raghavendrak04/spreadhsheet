// Starter tests for the engine. Extend this file (or add more *.test.js
// files) for every behaviour you implement. Graders run `npm test` and add
// their own hidden tests against the public engine API you document in
// DESIGN_NOTES.md.
import { describe, it, expect } from 'vitest'
import { createEngine, shiftFormulaForFill } from './core.js'

describe('engine basics', () => {
    it('evaluates arithmetic and ranges', () => {
        const engine = createEngine(10, 10)
        engine.setCell(0, 0, '10')
        engine.setCell(1, 0, '20')
        engine.setCell(2, 0, '=SUM(A1:A2)*2')
        expect(engine.getCell(2, 0).computed).toBe(60)
    })

    it('reports a cycle instead of hanging', () => {
        const engine = createEngine(10, 10)
        engine.setCell(0, 0, '=B1')
        engine.setCell(0, 1, '=A1')
        expect(engine.getCell(0, 1).error).toBe('#CYCLE!')
    })

    it('undoes and redoes a single edit', () => {
        const engine = createEngine(10, 10)
        engine.setCell(0, 0, 'hello')
        engine.setCell(0, 0, 'world')
        engine.undo()
        expect(engine.getCell(0, 0).raw).toBe('hello')
        engine.redo()
        expect(engine.getCell(0, 0).raw).toBe('world')
    })

    it('shifts references when a row is inserted above them', () => {
        const engine = createEngine(10, 10)
        engine.setCell(2, 0, '5')       // A3
        engine.setCell(4, 0, '=A3+1')   // A5
        engine.insertRow(1)             // A3 -> A4, A5 -> A6
        expect(engine.getCell(5, 0).raw).toBe('=A4+1')
        expect(engine.getCell(5, 0).computed).toBe(6)
    })
})

describe('challenge engine behaviour', () => {
  it('fills numeric, suffix, date, weekday, and formula series as one undo step', () => {
    const engine = createEngine(20, 10)
    engine.setRange({ start: { row: 0, col: 0 }, end: { row: 1, col: 0 } }, [['1'], ['2']])
    engine.fillRange({ start: { row: 0, col: 0 }, end: { row: 1, col: 0 } }, { start: { row: 0, col: 0 }, end: { row: 4, col: 0 } })
    expect(engine.getCell(4, 0).raw).toBe('5')
    engine.undo()
    expect(engine.getCell(4, 0).raw).toBe('')

    engine.setRange({ start: { row: 0, col: 1 }, end: { row: 1, col: 1 } }, [['ORD-009'], ['ORD-010']])
    engine.fillRange({ start: { row: 0, col: 1 }, end: { row: 1, col: 1 } }, { start: { row: 0, col: 1 }, end: { row: 3, col: 1 } })
    expect(engine.getCell(3, 1).raw).toBe('ORD-012')

    engine.setCell(0, 2, '2024-01-15')
    engine.fillRange({ start: { row: 0, col: 2 }, end: { row: 0, col: 2 } }, { start: { row: 0, col: 2 }, end: { row: 2, col: 2 } })
    expect(engine.getCell(2, 2).raw).toBe('2024-01-17')

    engine.setCell(0, 3, 'Mon')
    engine.fillRange({ start: { row: 0, col: 3 }, end: { row: 0, col: 3 } }, { start: { row: 0, col: 3 }, end: { row: 3, col: 3 } })
    expect(engine.getCell(3, 3).raw).toBe('Thu')
    expect(shiftFormulaForFill('=$A$1+B$2+$C3', 4, 3)).toBe('=$A$1+E$2+$C7')
  })

  it('applies styles to ranges and shifts them through structural changes', () => {
    const engine = createEngine(5, 5)
    engine.setRangeStyle({ start: { row: 1, col: 1 }, end: { row: 2, col: 2 } }, { bold: true, bg: '#cce5ff' })
    engine.insertRow(1)
    expect(engine.getStyle(2, 1)).toMatchObject({ bold: true, bg: '#cce5ff' })
    engine.insertColumn(1)
    expect(engine.getStyle(2, 2)).toMatchObject({ bold: true, bg: '#cce5ff' })
  })

  it('filters as a view and sorts rows physically with totals preserved', () => {
    const engine = createEngine(8, 3)
    engine.loadMatrix([
      ['Name', 'Region', 'Value'],
      ['A', 'West ', '4'],
      ['B', 'East', '2'],
      ['C', 'west', '3'],
      ['Total', '', '9'],
    ])
    engine.setFilter(1, { conditions: [{ op: 'eq', value: 'west' }] })
    expect(engine.getVisibleRows(1, 3)).toEqual([1, 3])
    engine.sortRange({ column: 2, direction: 'asc' })
    expect(engine.getCell(1, 0).raw).toBe('C')
    expect(engine.getCell(2, 0).raw).toBe('B')
    expect(engine.getCell(3, 0).raw).toBe('A')
    expect(engine.getCell(4, 0).raw).toBe('Total')
    engine.undo()
    expect(engine.getCell(1, 0).raw).toBe('A')
  })

  it('formats without changing raw values and rejects invalid freezing', () => {
    const engine = createEngine(6, 3)
    engine.loadMatrix([['Item', 'Price', 'Total'], ['A', '79', '$1,200.00'], ['Total', '', '$1,279.00']])
    expect(engine.applyFormat({ columns: [{ col: 1, style: { numberFormat: 'currency' } }], headerStyle: { bold: true }, totalsStyle: { bold: true }, freezeRows: 1 }).result).toBe('APPLIED')
    expect(engine.getDisplayCell(1, 1).display).toBe('$79.00')
    expect(engine.getCell(1, 1).raw).toBe('79')
    expect(engine.getStyle(0, 1).bold).toBe(true)
    expect(engine.applyFormat({ freezeRows: 3 }).error).toBe('OUT_OF_RANGE')
  })
})
