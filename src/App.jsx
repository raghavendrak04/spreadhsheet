import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import './App.css'
import { createEngine, indexToCellKey, indexToColumnLetter, normaliseRange, parseCellKey, rangeToA1 } from './engine/core.js'
import { loadSampleLarge, loadSampleSmall } from './fixtures/loadSample.js'
import { createProvider } from './ai/provider.js'
import { buildSheetContext, buildSystemPrompt } from './ai/context.js'
import { parseAndValidateAction } from './ai/response.js'
import { executeQuery } from './ai/queryExecutor.js'
import { applyFormat, previewFormat } from './ai/formatApplier.js'

const ROW_HEADER = 52
const COLUMN_HEADER = 28
const OVERSCAN = 4

function lowerBound(values, target) {
  let left = 0
  let right = values.length - 1
  while (left < right) {
    const middle = Math.floor((left + right) / 2)
    if (values[middle] < target) left = middle + 1
    else right = middle
  }
  return Math.max(0, left - 1)
}

function prefixSums(values) {
  const result = [0]
  for (const value of values) result.push(result[result.length - 1] + value)
  return result
}

function within(range, row, col) {
  const value = normaliseRange(range)
  return row >= value.startRow && row <= value.endRow && col >= value.startCol && col <= value.endCol
}

function samePoint(left, right) {
  return left && right && left.row === right.row && left.col === right.col
}

function cellCss(style) {
  return {
    background: style.bg,
    color: style.color,
    fontWeight: style.bold ? 700 : 400,
    fontStyle: style.italic ? 'italic' : 'normal',
    textDecoration: style.underline ? 'underline' : 'none',
    textAlign: style.align,
    fontSize: style.fontSize,
  }
}

export default function App() {
  const [engine] = useState(() => createEngine(100000, 200))
  const [, setVersion] = useState(0)
  const [selection, setSelection] = useState({ anchor: { row: 0, col: 0 }, focus: { row: 0, col: 0 } })
  const [editing, setEditing] = useState(null)
  const [editValue, setEditValue] = useState('')
  const [viewport, setViewport] = useState({ left: 0, top: 0, width: 900, height: 600 })
  const [fillPreview, setFillPreview] = useState(null)
  const [filterMenu, setFilterMenu] = useState(null)
  const [filterOp, setFilterOp] = useState('contains')
  const [filterValue, setFilterValue] = useState('')
  const [filterSearch, setFilterSearch] = useState('')
  const [filterValues, setFilterValues] = useState([])
  const [sortState, setSortState] = useState(null)
  const [nameBox, setNameBox] = useState('A1')
  const [aiOpen, setAiOpen] = useState(false)
  const [aiPrompt, setAiPrompt] = useState('')
  const [aiHistory, setAiHistory] = useState([])
  const [aiPending, setAiPending] = useState(null)
  const [showPlan, setShowPlan] = useState(false)
  const [destination, setDestination] = useState('M2')
  const scrollRef = useRef(null)
  const inputRef = useRef(null)
  const dragRef = useRef({ active: false, filling: false, resize: null })

  const refresh = useCallback(() => setVersion(version => version + 1), [])
  const selectedRange = useMemo(() => normaliseRange(selection), [selection])
  // The engine keeps dimensions outside React state; an explicit refresh triggers
  // rendering after each mutation, at which point these inexpensive prefix sums update.
  const columnOffsets = prefixSums(engine.columnWidths)
  const rowOffsets = prefixSums(engine.rowHeights)

  const visible = useMemo(() => {
    const startRow = Math.max(0, lowerBound(rowOffsets, viewport.top) - OVERSCAN)
    const endRow = Math.min(engine.rows - 1, lowerBound(rowOffsets, viewport.top + viewport.height) + OVERSCAN + 1)
    const startCol = Math.max(0, lowerBound(columnOffsets, viewport.left) - OVERSCAN)
    const endCol = Math.min(engine.cols - 1, lowerBound(columnOffsets, viewport.left + viewport.width) + OVERSCAN + 1)
    return { startRow, endRow, startCol, endCol }
  }, [columnOffsets, engine.cols, engine.rows, rowOffsets, viewport])

  const rangeStyle = engine.getStyle(selectedRange.startRow, selectedRange.startCol)
  const selectedCell = engine.getDisplayCell(selection.focus.row, selection.focus.col)
  const used = engine.getUsedRange()
  const visibleRows = engine.getVisibleRows(used.startRow + 1, used.endRow)
  const collectDistinctFilterValues = useCallback(column => {
    const values = new Map()
    for (let row = used.startRow + 1; row <= used.endRow; row += 1) {
      const display = String(engine.getCell(row, column).computed ?? '')
      const key = display.trim().toLowerCase()
      if (!values.has(key)) values.set(key, display)
    }
    return Array.from(values.values()).sort((left, right) => left.localeCompare(right))
  }, [engine, used.endRow, used.startRow])
  const distinctFilterValues = useMemo(() => filterMenu === null ? [] : collectDistinctFilterValues(filterMenu), [collectDistinctFilterValues, filterMenu])

  const scrollToCell = useCallback((row, col) => {
    const scroll = scrollRef.current
    if (!scroll) return
    scroll.scrollTo({ left: Math.max(0, columnOffsets[col] - 80), top: Math.max(0, rowOffsets[row] - 60), behavior: 'auto' })
  }, [columnOffsets, rowOffsets])

  const beginEdit = useCallback((point, seed = null) => {
    const cell = engine.getCell(point.row, point.col)
    setEditing(point)
    setEditValue(seed ?? cell.raw)
    setSelection({ anchor: point, focus: point })
    requestAnimationFrame(() => inputRef.current?.focus())
  }, [engine])

  const commitEdit = useCallback(() => {
    if (!editing) return
    engine.setCell(editing.row, editing.col, editValue)
    setEditing(null)
    refresh()
  }, [editing, editValue, engine, refresh])

  const selectCell = useCallback((point, extend = false) => {
    if (editing && !samePoint(editing, point)) commitEdit()
    setSelection(previous => extend ? { anchor: previous.anchor, focus: point } : { anchor: point, focus: point })
    setNameBox(indexToCellKey(point.row, point.col))
  }, [commitEdit, editing])

  const applyStyle = useCallback(patch => {
    engine.setRangeStyle(selectedRange, patch)
    refresh()
  }, [engine, refresh, selectedRange])

  const clearSelection = useCallback(() => {
    engine.clearRange(selectedRange)
    refresh()
  }, [engine, refresh, selectedRange])

  const moveSelection = useCallback((rowDelta, colDelta, extend = false) => {
    const origin = selection.focus
    const point = { row: Math.max(0, Math.min(engine.rows - 1, origin.row + rowDelta)), col: Math.max(0, Math.min(engine.cols - 1, origin.col + colDelta)) }
    selectCell(point, extend)
    scrollToCell(point.row, point.col)
  }, [engine.cols, engine.rows, scrollToCell, selectCell, selection.focus])

  useEffect(() => {
    const finishPointer = () => {
      if (dragRef.current.filling && fillPreview) {
        engine.fillRange(selectedRange, fillPreview)
        setSelection({ anchor: selectedRange ? { row: selectedRange.startRow, col: selectedRange.startCol } : selection.anchor, focus: { row: fillPreview.endRow, col: fillPreview.endCol } })
        refresh()
      }
      dragRef.current = { active: false, filling: false, resize: null }
      setFillPreview(null)
    }
    const handlePointerMove = event => {
      const resize = dragRef.current.resize
      if (!resize) return
      const delta = resize.axis === 'column' ? event.clientX - resize.start : event.clientY - resize.start
      if (resize.axis === 'column') engine.setColumnWidth(resize.index, resize.size + delta)
      else engine.setRowHeight(resize.index, resize.size + delta)
      refresh()
    }
    window.addEventListener('pointerup', finishPointer)
    window.addEventListener('pointermove', handlePointerMove)
    return () => { window.removeEventListener('pointerup', finishPointer); window.removeEventListener('pointermove', handlePointerMove) }
  }, [engine, fillPreview, refresh, selectedRange, selection.anchor])

  useEffect(() => {
    const onKeyDown = event => {
      if (event.ctrlKey && event.key.toLowerCase() === 'k') { event.preventDefault(); setAiOpen(true); return }
      if (event.ctrlKey && event.key.toLowerCase() === 'z') { event.preventDefault(); if (event.shiftKey) engine.redo(); else engine.undo(); refresh(); return }
      if (event.ctrlKey && event.key.toLowerCase() === 'a') { event.preventDefault(); setSelection({ anchor: { row: used.startRow, col: used.startCol }, focus: { row: used.endRow, col: used.endCol } }); return }
      if (editing) return
      if (event.key === 'Delete' || event.key === 'Backspace') { event.preventDefault(); clearSelection(); return }
      if (event.key === 'Enter' || event.key === 'F2') { event.preventDefault(); beginEdit(selection.focus); return }
      if (event.key === 'ArrowDown') { event.preventDefault(); moveSelection(1, 0, event.shiftKey); return }
      if (event.key === 'ArrowUp') { event.preventDefault(); moveSelection(-1, 0, event.shiftKey); return }
      if (event.key === 'ArrowLeft') { event.preventDefault(); moveSelection(0, -1, event.shiftKey); return }
      if (event.key === 'ArrowRight') { event.preventDefault(); moveSelection(0, 1, event.shiftKey); return }
      if (event.key === 'PageDown') { event.preventDefault(); moveSelection(Math.ceil(viewport.height / 24), 0, event.shiftKey); return }
      if (event.key === 'PageUp') { event.preventDefault(); moveSelection(-Math.ceil(viewport.height / 24), 0, event.shiftKey); return }
      if (event.ctrlKey && event.key === 'Home') { event.preventDefault(); selectCell({ row: 0, col: 0 }); scrollToCell(0, 0); return }
      if (event.ctrlKey && event.key === 'End') { event.preventDefault(); selectCell({ row: used.endRow, col: used.endCol }); scrollToCell(used.endRow, used.endCol); return }
      if (!event.ctrlKey && !event.metaKey && event.key.length === 1) { event.preventDefault(); beginEdit(selection.focus, event.key) }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [beginEdit, clearSelection, editing, engine, moveSelection, refresh, scrollToCell, selectCell, selection.focus, used, viewport.height])

  const onScroll = event => {
    const element = event.currentTarget
    setViewport(current => ({ ...current, left: element.scrollLeft, top: element.scrollTop, width: element.clientWidth, height: element.clientHeight }))
  }

  const loadSample = loader => {
    loader(engine)
    setSelection({ anchor: { row: 0, col: 0 }, focus: { row: 0, col: 0 } })
    refresh()
  }

  const beginResize = (event, axis, index) => {
    event.preventDefault()
    event.stopPropagation()
    dragRef.current.resize = { axis, index, start: axis === 'column' ? event.clientX : event.clientY, size: axis === 'column' ? engine.getColumnWidth(index) : engine.getRowHeight(index) }
  }

  const cycleSort = column => {
    const direction = sortState?.column === column ? (sortState.direction === 'asc' ? 'desc' : sortState.direction === 'desc' ? 'original' : 'asc') : 'asc'
    engine.sortRange({ column, direction })
    setSortState({ column, direction })
    refresh()
  }

  const applyFilter = () => {
    if (filterMenu === null) return
    engine.setFilter(filterMenu, { values: filterValues.length === distinctFilterValues.length ? null : filterValues, conditions: filterOp === 'isEmpty' ? [{ op: filterOp }] : [{ op: filterOp, value: filterValue }] })
    setFilterMenu(null)
    refresh()
  }

  const jumpToName = event => {
    event.preventDefault()
    const point = parseCellKey(nameBox)
    if (!point) return
    engine.ensureCapacity(point.row + 1, point.col + 1)
    selectCell(point)
    scrollToCell(point.row, point.col)
    refresh()
  }

  const sendAi = async event => {
    event.preventDefault()
    const prompt = aiPrompt.trim()
    if (!prompt) return
    setAiPending({ status: 'loading', prompt })
    try {
      const context = buildSheetContext(engine, selection)
      const provider = createProvider()
      const response = await provider.complete({ system: `${buildSystemPrompt()}\nContext:\n${JSON.stringify(context)}`, user: JSON.stringify({ context, prompt }), history: aiHistory })
      const parsed = parseAndValidateAction(response.text)
      if (!parsed.ok) {
        setAiPending({ status: 'error', prompt, error: parsed.error })
      } else if (parsed.value.type === 'query') {
        const result = executeQuery(engine.getTableSnapshot(), parsed.value)
        setAiPending(result.error ? { status: 'error', prompt, plan: parsed.value, error: result.detail ?? result.error } : { status: 'query', prompt, plan: parsed.value, result })
      } else if (parsed.value.type === 'format_sheet') {
        const preview = previewFormat(engine, parsed.value)
        setAiPending(preview.error ? { status: 'error', prompt, plan: parsed.value, error: preview.detail ?? preview.error } : { status: 'format', prompt, plan: parsed.value, preview })
      } else {
        setAiPending({ status: 'clarify', prompt, plan: parsed.value })
      }
      setAiHistory(history => [...history, { role: 'user', content: prompt }, { role: 'assistant', content: response.text }])
      setAiPrompt('')
    } catch (error) {
      setAiPending({ status: 'error', prompt, error: error.message })
    }
  }

  const rerunQuery = () => {
    if (aiPending?.status !== 'query') return
    const result = executeQuery(engine.getTableSnapshot(), aiPending.plan)
    setAiPending(result.error ? { ...aiPending, status: 'error', error: result.detail ?? result.error } : { ...aiPending, result })
  }

  const insertAiResult = () => {
    if (aiPending?.status !== 'query') return
    engine.insertTable(destination, aiPending.result)
    refresh()
  }

  const applyAiFormat = () => {
    if (aiPending?.status !== 'format') return
    const result = applyFormat(engine, aiPending.plan)
    setAiPending({ ...aiPending, applied: result })
    refresh()
  }

  const visibleRowsForRender = Array.from({ length: visible.endRow - visible.startRow + 1 }, (_, offset) => visible.startRow + offset)
  const visibleColumnsForRender = Array.from({ length: visible.endCol - visible.startCol + 1 }, (_, offset) => visible.startCol + offset)
  const bodyCells = visibleRowsForRender.flatMap(row => visibleColumnsForRender.flatMap(col => {
    if (row === 0 || col === 0) return []
    const cell = engine.getDisplayCell(row, col)
    const active = within(selectedRange, row, col)
    const isEditing = samePoint(editing, { row, col })
    return [
        <div
          key={`${row}:${col}`}
          className={`grid-cell ${active ? 'selected' : ''}`}
          style={{ left: ROW_HEADER + columnOffsets[col], top: COLUMN_HEADER + rowOffsets[row], width: engine.getColumnWidth(col), height: engine.getRowHeight(row), ...cellCss(cell.style) }}
          onPointerDown={event => { event.preventDefault(); dragRef.current.active = true; selectCell({ row, col }, event.shiftKey) }}
          onPointerEnter={() => { if (dragRef.current.active) setSelection(previous => ({ anchor: previous.anchor, focus: { row, col } })); if (dragRef.current.filling) setFillPreview({ startRow: selectedRange.startRow, startCol: selectedRange.startCol, endRow: row, endCol: col }) }}
          onDoubleClick={() => beginEdit({ row, col })}
        >
          {isEditing ? <input ref={inputRef} className="cell-editor" value={editValue} onChange={event => setEditValue(event.target.value)} onBlur={commitEdit} onKeyDown={event => { if (event.key === 'Enter') { event.preventDefault(); commitEdit(); moveSelection(1, 0) } if (event.key === 'Escape') { setEditing(null) } }} /> : <span>{cell.display}</span>}
          {row === selectedRange.endRow && col === selectedRange.endCol && <button className="fill-handle" title="Drag to fill" onPointerDown={event => { event.stopPropagation(); dragRef.current.filling = true }} />}
        </div>,
    ]
  }))

  const frozenTopCells = visibleColumnsForRender.map(col => {
    const cell = engine.getDisplayCell(0, col)
    return <div key={`top:${col}`} className={`grid-cell frozen-row ${within(selectedRange, 0, col) ? 'selected' : ''}`} style={{ left: ROW_HEADER + columnOffsets[col] - viewport.left, top: COLUMN_HEADER, width: engine.getColumnWidth(col), height: engine.getRowHeight(0), ...cellCss(cell.style) }} onPointerDown={event => { event.preventDefault(); selectCell({ row: 0, col }, event.shiftKey) }} onDoubleClick={() => beginEdit({ row: 0, col })}>{samePoint(editing, { row: 0, col }) ? <input ref={inputRef} className="cell-editor" value={editValue} onChange={event => setEditValue(event.target.value)} onBlur={commitEdit} /> : <span>{cell.display}</span>}</div>
  })
  const frozenLeftCells = visibleRowsForRender.filter(row => row !== 0).map(row => {
    const cell = engine.getDisplayCell(row, 0)
    return <div key={`left:${row}`} className={`grid-cell frozen-column ${within(selectedRange, row, 0) ? 'selected' : ''}`} style={{ left: ROW_HEADER, top: COLUMN_HEADER + rowOffsets[row] - viewport.top, width: engine.getColumnWidth(0), height: engine.getRowHeight(row), ...cellCss(cell.style) }} onPointerDown={event => { event.preventDefault(); selectCell({ row, col: 0 }, event.shiftKey) }} onDoubleClick={() => beginEdit({ row, col: 0 })}><span>{cell.display}</span></div>
  })
  const frozenCells = [...frozenTopCells, ...frozenLeftCells]

  return (
    <main className="app-shell">
      <header className="app-header"><div><strong>Spreadsheet</strong><span className="subtle">Pure engine · virtual grid · deterministic AI</span></div><button onClick={() => setAiOpen(true)}>Ask AI <kbd>Ctrl K</kbd></button></header>
      <section className="toolbar" aria-label="Spreadsheet toolbar">
        <button className={rangeStyle.bold ? 'active' : ''} onClick={() => applyStyle({ bold: !rangeStyle.bold })}><b>B</b></button>
        <button className={rangeStyle.italic ? 'active' : ''} onClick={() => applyStyle({ italic: !rangeStyle.italic })}><i>I</i></button>
        <button className={rangeStyle.underline ? 'active' : ''} onClick={() => applyStyle({ underline: !rangeStyle.underline })}><u>U</u></button>
        <select value={rangeStyle.numberFormat} onChange={event => applyStyle({ numberFormat: event.target.value })}><option value="general">General</option><option value="number">Number</option><option value="currency">Currency</option><option value="percent">Percent</option><option value="date">Date</option></select>
        <select value={rangeStyle.align} onChange={event => applyStyle({ align: event.target.value })}><option value="left">Left</option><option value="center">Center</option><option value="right">Right</option></select>
        <input aria-label="Background color" type="color" value={rangeStyle.bg === 'white' ? '#ffffff' : rangeStyle.bg} onChange={event => applyStyle({ bg: event.target.value })} />
        <button onClick={() => { engine.undo(); refresh() }} disabled={!engine.canUndo()}>Undo</button><button onClick={() => { engine.redo(); refresh() }} disabled={!engine.canRedo()}>Redo</button>
        <button onClick={() => { engine.insertRow(selection.focus.row); refresh() }}>+ Row</button><button onClick={() => { engine.insertColumn(selection.focus.col); refresh() }}>+ Col</button>
        <button onClick={clearSelection}>Clear</button><button onClick={() => loadSample(loadSampleSmall)}>Sample 33</button><button onClick={() => loadSample(loadSampleLarge)}>Sample 3k</button>
      </section>
      <section className="formula-row">
        <form onSubmit={jumpToName}><input aria-label="Name box" value={nameBox} onChange={event => setNameBox(event.target.value)} /></form>
        <input className="formula-input" aria-label="Formula bar" value={editing ? editValue : selectedCell.raw} onChange={event => { if (!editing) beginEdit(selection.focus, event.target.value); else setEditValue(event.target.value) }} onKeyDown={event => { if (event.key === 'Enter') { event.preventDefault(); commitEdit() } }} />
        <span>{rangeToA1(selectedRange)}</span>
      </section>
      <section className="grid-shell">
        <div ref={scrollRef} className="grid-scroll" onScroll={onScroll} onPointerDown={event => { if (event.target === event.currentTarget) selectCell({ row: 0, col: 0 }) }}>
          <div className="grid-canvas" style={{ width: ROW_HEADER + columnOffsets[columnOffsets.length - 1], height: COLUMN_HEADER + rowOffsets[rowOffsets.length - 1] }}>{bodyCells}</div>
        </div>
        <div className="column-layer">
          <div className="corner" onClick={() => setSelection({ anchor: { row: used.startRow, col: used.startCol }, focus: { row: used.endRow, col: used.endCol } })} />
          {Array.from({ length: visible.endCol - visible.startCol + 1 }, (_, offset) => { const col = visible.startCol + offset; return <div key={col} className="column-header" style={{ left: ROW_HEADER + columnOffsets[col] - viewport.left, width: engine.getColumnWidth(col) }} onClick={() => setSelection({ anchor: { row: 0, col }, focus: { row: engine.rows - 1, col } })} onDoubleClick={() => { engine.autoFitColumns([col]); refresh() }}><span>{indexToColumnLetter(col)}</span><button aria-label={`Sort column ${indexToColumnLetter(col)}`} title="Sort" onClick={event => { event.stopPropagation(); cycleSort(col) }}>↕</button><button aria-label={`Filter column ${indexToColumnLetter(col)}`} onClick={event => { event.stopPropagation(); setFilterMenu(col); setFilterSearch(''); setFilterValues(collectDistinctFilterValues(col)) }}>⌄</button><i onPointerDown={event => beginResize(event, 'column', col)} /></div> })}
        </div>
        <div className="row-layer">{Array.from({ length: visible.endRow - visible.startRow + 1 }, (_, offset) => { const row = visible.startRow + offset; return <div key={row} className="row-header" style={{ top: COLUMN_HEADER + rowOffsets[row] - viewport.top, height: engine.getRowHeight(row) }} onClick={() => setSelection({ anchor: { row, col: 0 }, focus: { row, col: engine.cols - 1 } })}><span>{row + 1}</span><i onPointerDown={event => beginResize(event, 'row', row)} /></div> })}</div>
        <div className="frozen-layer">{frozenCells}</div>
        {filterMenu !== null && <aside className="filter-menu" style={{ left: Math.max(ROW_HEADER, ROW_HEADER + columnOffsets[filterMenu] - viewport.left), top: COLUMN_HEADER + 4 }}><strong>Filter {indexToColumnLetter(filterMenu)}</strong><input value={filterSearch} onChange={event => setFilterSearch(event.target.value)} placeholder="Search values" /><div className="filter-values">{distinctFilterValues.filter(value => value.toLowerCase().includes(filterSearch.toLowerCase())).slice(0, 100).map(value => <label key={value || '(blank)'}><input type="checkbox" checked={filterValues.includes(value)} onChange={event => setFilterValues(values => event.target.checked ? [...values, value] : values.filter(item => item !== value))} /> {value || '(Blanks)'}</label>)}</div><select value={filterOp} onChange={event => setFilterOp(event.target.value)}><option value="contains">contains</option><option value="gt">greater than</option><option value="lt">less than</option><option value="isEmpty">is empty</option></select>{filterOp !== 'isEmpty' && <input value={filterValue} onChange={event => setFilterValue(event.target.value)} placeholder="Condition value" />}<div><button onClick={applyFilter}>Apply</button><button onClick={() => { engine.clearFilter(filterMenu); setFilterMenu(null); refresh() }}>Clear</button></div><small>{visibleRows.length} of {Math.max(0, used.rowCount - 1)} rows visible</small></aside>}
      </section>
      <footer>{visibleRows.length} of {Math.max(0, used.rowCount - 1)} rows visible · {engine.rows.toLocaleString()} rows × {engine.cols} columns · Selection: {rangeToA1(selectedRange)}</footer>
      {aiOpen && <aside className="ai-panel" aria-label="Ask your data"><header><strong>Ask your data</strong><button onClick={() => setAiOpen(false)}>×</button></header><form onSubmit={sendAi}><textarea value={aiPrompt} onChange={event => setAiPrompt(event.target.value)} placeholder="Ask a question or request formatting" /><button disabled={!aiPrompt.trim()}>Send</button></form><label className="plan-toggle"><input type="checkbox" checked={showPlan} onChange={event => setShowPlan(event.target.checked)} /> Show plan</label>{aiPending?.status === 'loading' && <p>Creating a validated plan…</p>}{aiPending?.status === 'error' && <p className="ai-error">{aiPending.error}</p>}{aiPending?.status === 'clarify' && <p>{aiPending.plan.question}</p>}{aiPending?.status === 'query' && <section className="ai-card"><strong>{aiPending.result.rowCount} result rows{aiPending.result.truncated ? ' (truncated)' : ''}</strong><p>The spreadsheet executed the validated query locally.</p>{showPlan && <pre>{JSON.stringify(aiPending.plan, null, 2)}</pre>}<div className="result-table"><table><thead><tr>{aiPending.result.columns.map(column => <th key={column}>{column}</th>)}</tr></thead><tbody>{aiPending.result.rows.slice(0, 25).map((row, index) => <tr key={index}>{row.map((value, col) => <td key={col}>{String(value ?? '')}</td>)}</tr>)}</tbody></table></div><button onClick={rerunQuery}>Re-run</button><input value={destination} onChange={event => setDestination(event.target.value)} aria-label="Insert destination" /><button onClick={insertAiResult}>Insert into sheet</button></section>}{aiPending?.status === 'format' && <section className="ai-card"><p>{aiPending.preview.description}</p>{showPlan && <pre>{JSON.stringify(aiPending.plan, null, 2)}</pre>}{aiPending.applied ? <p>{aiPending.applied.error ?? aiPending.applied.result}</p> : <><button onClick={applyAiFormat}>Apply once</button><button onClick={() => setAiPending(null)}>Discard</button></>}</section>}</aside>}
    </main>
  )
}
