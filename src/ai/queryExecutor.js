import { MAX_RESULT_ROWS } from './contract.js'

const normalise = value => String(value ?? '').trim().toLowerCase()
const toNumber = value => { const text = String(value ?? '').trim(); if (!text) return null; const percent = text.endsWith('%'); const stripped = text.replace(/[,$%\s]/g, ''); if (!/^-?\d+(\.\d+)?$/.test(stripped)) return null; const number = Number(stripped); return percent ? number / 100 : number }
const toDate = value => { const text = String(value ?? '').trim(); let match = text.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/); if (match) return `${match[1]}-${match[2].padStart(2, '0')}-${match[3].padStart(2, '0')}`; match = text.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/); if (match) return `${match[3]}-${match[1].padStart(2, '0')}-${match[2].padStart(2, '0')}`; match = text.match(/^(\d{1,2})\s+([A-Za-z]{3,})\s+(\d{4})$/); if (match) { const month = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'].indexOf(match[2].slice(0, 3).toLowerCase()); return month >= 0 ? `${match[3]}-${String(month + 1).padStart(2, '0')}-${match[1].padStart(2, '0')}` : null } return null }
const looksLikeTotal = value => /^(grand\s+)?(total|totals|subtotal|sum)\b/i.test(String(value ?? '').trim())

function findColumn(headers, name) { const index = headers.findIndex(header => normalise(header) === normalise(name)); return index < 0 ? { error: 'UNKNOWN_COLUMN', detail: `UNKNOWN_COLUMN:${name}` } : { index } }
function matches(value, filter) { const text = normalise(value); const target = normalise(filter.value); const number = toNumber(value); const targetNumber = toNumber(filter.value); const date = toDate(value); const targetDate = toDate(filter.value); switch (filter.op) { case 'eq': return number !== null && targetNumber !== null ? number === targetNumber : text === target; case 'neq': return number !== null && targetNumber !== null ? number !== targetNumber : text !== target; case 'gt': return targetDate ? Boolean(date && date > targetDate) : Boolean(number !== null && targetNumber !== null && number > targetNumber); case 'gte': return targetDate ? Boolean(date && date >= targetDate) : Boolean(number !== null && targetNumber !== null && number >= targetNumber); case 'lt': return targetDate ? Boolean(date && date < targetDate) : Boolean(number !== null && targetNumber !== null && number < targetNumber); case 'lte': return targetDate ? Boolean(date && date <= targetDate) : Boolean(number !== null && targetNumber !== null && number <= targetNumber); case 'contains': return text.includes(target); case 'startsWith': return text.startsWith(target); case 'endsWith': return text.endsWith(target); case 'isEmpty': return text === ''; case 'notEmpty': return text !== ''; default: return null } }
function compare(left, right) { const leftNumber = toNumber(left); const rightNumber = toNumber(right); if (leftNumber !== null && rightNumber !== null) return leftNumber - rightNumber; if (leftNumber !== null) return -1; if (rightNumber !== null) return 1; return normalise(left).localeCompare(normalise(right)) }
function rounded(value) { return typeof value === 'number' ? Math.round(value * 100) / 100 : value }

export function executeQuery(snapshot, plan) {
  if (plan?.type !== 'query') return { error: 'READ_ONLY', detail: 'READ_ONLY' }
  const headers = snapshot.headers
  const columnIndex = name => { const result = findColumn(headers, name); return result.error ? result : { index: result.index } }
  const filterIndexes = []
  for (const filter of plan.filters ?? []) { if (!['eq', 'neq', 'gt', 'gte', 'lt', 'lte', 'contains', 'startsWith', 'endsWith', 'isEmpty', 'notEmpty'].includes(filter.op)) return { error: 'UNKNOWN_OP', detail: `UNKNOWN_OP:${filter.op}` }; const found = columnIndex(filter.column); if (found.error) return found; filterIndexes.push({ ...filter, index: found.index }) }
  const groupIndexes = []
  for (const name of plan.groupBy ?? []) { const found = columnIndex(name); if (found.error) return found; groupIndexes.push({ name, index: found.index }) }
  const aggregateIndexes = []
  for (const aggregate of plan.aggregates ?? []) { if (!['sum', 'avg', 'count', 'countDistinct', 'min', 'max'].includes(aggregate.fn)) return { error: 'UNKNOWN_FN', detail: `UNKNOWN_FN:${aggregate.fn}` }; const found = columnIndex(aggregate.column); if (found.error) return found; aggregateIndexes.push({ ...aggregate, index: found.index, label: aggregate.as ?? `${aggregate.fn}(${aggregate.column})` }) }
  const rows = snapshot.values.map((values, index) => ({ values, index })).filter(row => row.values.some(value => normalise(value) !== ''))
  const input = plan.excludeTotalsRow !== false && rows.length && looksLikeTotal(rows[rows.length - 1].values.find(value => normalise(value) !== '')) ? rows.slice(0, -1) : rows
  const filtered = input.filter(row => filterIndexes.every(filter => matches(row.values[filter.index], filter)))
  let result
  if (aggregateIndexes.length) {
    const groups = new Map()
    for (const row of filtered) {
      const key = groupIndexes.map(group => normalise(row.values[group.index])).join('\u0000')
      if (!groups.has(key)) groups.set(key, { labels: groupIndexes.map(group => String(row.values[group.index] ?? '').trim()), rows: [] })
      groups.get(key).rows.push(row)
    }
    const columns = [...groupIndexes.map(group => group.name), ...aggregateIndexes.map(aggregate => aggregate.label)]
    const outputRows = Array.from(groups.values(), group => {
      const values = aggregateIndexes.map(aggregate => {
        const raw = group.rows.map(row => row.values[aggregate.index]); const numbers = raw.map(toNumber).filter(value => value !== null)
        if (aggregate.fn === 'count') return raw.filter(value => normalise(value) !== '').length
        if (aggregate.fn === 'countDistinct') return new Set(raw.filter(value => normalise(value) !== '').map(normalise)).size
        if (!numbers.length) return null
        if (aggregate.fn === 'sum') return numbers.reduce((sum, value) => sum + value, 0)
        if (aggregate.fn === 'avg') return numbers.reduce((sum, value) => sum + value, 0) / numbers.length
        if (aggregate.fn === 'min') return Math.min(...numbers)
        if (aggregate.fn === 'max') return Math.max(...numbers)
        return null
      })
      return [...group.labels, ...values.map(rounded)]
    })
    result = { columns, rows: outputRows }
  } else {
    const requested = plan.columns ?? headers
    const indexes = []
    for (const name of requested) { const found = columnIndex(name); if (found.error) return found; indexes.push(found.index) }
    result = { columns: requested, rows: filtered.map(row => indexes.map(index => row.values[index])) }
  }
  for (const sort of [...(plan.sort ?? [])].reverse()) {
    const index = result.columns.findIndex(column => normalise(column) === normalise(sort.column))
    if (index < 0) return { error: 'UNKNOWN_SORT_COLUMN', detail: `UNKNOWN_SORT_COLUMN:${sort.column}` }
    result.rows = result.rows.map((row, position) => ({ row, position })).sort((left, right) => { const comparison = compare(left.row[index], right.row[index]); return comparison === 0 ? left.position - right.position : (sort.dir === 'desc' ? -comparison : comparison) }).map(item => item.row)
  }
  const limit = Math.min(MAX_RESULT_ROWS, plan.limit ?? MAX_RESULT_ROWS)
  const truncated = result.rows.length > limit
  const outputRows = result.rows.slice(0, limit)
  return { columns: result.columns, rows: outputRows, rowCount: outputRows.length, truncated }
}
