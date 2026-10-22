import { rangeToA1 } from '../engine/core.js'

function inferColumnType(values, header) {
  const samples = values.filter(value => String(value ?? '').trim() !== '').slice(0, 12).map(value => String(value).trim())
  const name = String(header).toLowerCase()
  if (/id$|order/.test(name)) return 'id'
  if (samples.some(value => /%$/.test(value))) return 'percent'
  if (samples.some(value => /^\$/.test(value))) return 'currency'
  if (samples.length && samples.every(value => /^\d{4}-\d{1,2}-\d{1,2}$|^\d{1,2}\/\d{1,2}\/\d{4}$|^\d{1,2}\s+[A-Za-z]{3,}\s+\d{4}$/.test(value))) return 'date'
  if (samples.length && samples.every(value => /^-?[\d,$]+(?:\.\d+)?%?$/.test(value))) return 'number'
  return 'text'
}

export function buildSheetContext(engine, selection) {
  const snapshot = engine.getTableSnapshot()
  const columns = snapshot.headers.map((name, index) => {
    const values = snapshot.values.map(row => row[index])
    return { name, index, type: inferColumnType(values, name), examples: values.slice(0, 5) }
  })
  const lastRow = snapshot.values[snapshot.values.length - 1] ?? []
  const firstLastRowValue = lastRow.find(value => String(value ?? '').trim() !== '')
  return {
    range: rangeToA1({ start: { row: snapshot.used.startRow, col: snapshot.used.startCol }, end: { row: snapshot.used.endRow, col: snapshot.used.endCol } }),
    rowCount: snapshot.values.length,
    columns,
    sampleRows: snapshot.values.slice(0, 5),
    selection: selection ? rangeToA1(selection) : null,
    hasTotalsRow: /^(grand\s+)?(total|totals|subtotal|sum)\b/i.test(String(firstLastRowValue ?? '').trim()),
  }
}

export function buildSystemPrompt() {
  return 'Translate the user request into exactly one top-level JSON object. The object MUST contain a type field whose value is exactly query, format_sheet, or clarify. Return the action itself, never wrap it in an action, plan, response, or data property. Examples: {"type":"query","columns":["Region"],"limit":10}; {"type":"format_sheet","headerStyle":{"bold":true}}; {"type":"clarify","question":"Which column should I use?"}. Never calculate results. Column names must match the context exactly. Query plans may filter, group, aggregate, project, sort, and limit. Format plans may only use documented style, width, autofit, and frozen-row fields.'
}
