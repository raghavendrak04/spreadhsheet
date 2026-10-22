import { ACTION_TYPES, AGGREGATE_FNS, FILTER_OPS, FORMAT_SHEET_SCHEMA, NUMBER_FORMATS, QUERY_PLAN_SCHEMA } from './contract.js'

// Finds the first complete JSON object without trusting prose or Markdown fences.
export function extractFirstJsonObject(text) {
  let depth = 0
  let start = -1
  let quote = false
  let escaped = false
  for (let index = 0; index < String(text ?? '').length; index += 1) {
    const character = text[index]
    if (quote) {
      if (escaped) escaped = false
      else if (character === '\\') escaped = true
      else if (character === '"') quote = false
      continue
    }
    if (character === '"') { quote = true; continue }
    if (character === '{') { if (depth === 0) start = index; depth += 1 }
    if (character === '}') {
      depth -= 1
      if (depth === 0 && start >= 0) return text.slice(start, index + 1)
      if (depth < 0) break
    }
  }
  throw new Error('INVALID_RESPONSE: no JSON object found')
}

function typeOf(value) {
  if (value === null) return 'null'
  if (Array.isArray(value)) return 'array'
  return typeof value
}

function validateStyle(style, at) {
  if (typeOf(style) !== 'object') return `${at} must be an object`
  const allowed = ['bold', 'italic', 'underline', 'bg', 'color', 'align', 'fontSize', 'numberFormat']
  for (const key of Object.keys(style)) if (!allowed.includes(key)) return `${at}.${key} is not allowed`
  if (style.bold !== undefined && typeof style.bold !== 'boolean') return `${at}.bold must be boolean`
  if (style.italic !== undefined && typeof style.italic !== 'boolean') return `${at}.italic must be boolean`
  if (style.underline !== undefined && typeof style.underline !== 'boolean') return `${at}.underline must be boolean`
  if (style.bg !== undefined && !/^#[0-9a-fA-F]{6}$|^white$/.test(style.bg)) return `${at}.bg is invalid`
  if (style.color !== undefined && !/^#[0-9a-fA-F]{6}$/.test(style.color)) return `${at}.color is invalid`
  if (style.align !== undefined && !['left', 'center', 'right'].includes(style.align)) return `${at}.align is invalid`
  if (style.fontSize !== undefined && (!Number.isInteger(style.fontSize) || style.fontSize < 8 || style.fontSize > 24)) return `${at}.fontSize is invalid`
  if (style.numberFormat !== undefined && !NUMBER_FORMATS.includes(style.numberFormat)) return `${at}.numberFormat is invalid`
  return null
}

function validateQuery(plan) {
  const allowed = Object.keys(QUERY_PLAN_SCHEMA.properties)
  for (const key of Object.keys(plan)) if (!allowed.includes(key)) return `${key} is not allowed`
  if (plan.excludeTotalsRow !== undefined && typeof plan.excludeTotalsRow !== 'boolean') return 'excludeTotalsRow must be boolean'
  for (const [index, filter] of (plan.filters ?? []).entries()) {
    if (typeOf(filter) !== 'object' || typeof filter.column !== 'string' || !FILTER_OPS.includes(filter.op)) return `filters[${index}] is invalid`
    if (filter.value !== undefined && !['string', 'number', 'null'].includes(typeOf(filter.value))) return `filters[${index}].value is invalid`
  }
  if (plan.groupBy !== undefined && (!Array.isArray(plan.groupBy) || plan.groupBy.some(value => typeof value !== 'string'))) return 'groupBy must be a string array'
  for (const [index, aggregate] of (plan.aggregates ?? []).entries()) {
    if (typeOf(aggregate) !== 'object' || !AGGREGATE_FNS.includes(aggregate.fn) || typeof aggregate.column !== 'string' || (aggregate.as !== undefined && typeof aggregate.as !== 'string')) return `aggregates[${index}] is invalid`
  }
  if (plan.columns !== undefined && (!Array.isArray(plan.columns) || plan.columns.some(value => typeof value !== 'string'))) return 'columns must be a string array'
  for (const [index, sort] of (plan.sort ?? []).entries()) if (typeOf(sort) !== 'object' || typeof sort.column !== 'string' || (sort.dir !== undefined && !['asc', 'desc'].includes(sort.dir))) return `sort[${index}] is invalid`
  if (plan.limit !== undefined && (!Number.isInteger(plan.limit) || plan.limit < 1)) return 'limit must be a positive integer'
  return null
}

function validateFormat(plan) {
  const allowed = Object.keys(FORMAT_SHEET_SCHEMA.properties)
  for (const key of Object.keys(plan)) if (!allowed.includes(key)) return `${key} is not allowed`
  if (plan.clearFormatting !== undefined && typeof plan.clearFormatting !== 'boolean') return 'clearFormatting must be boolean'
  for (const key of ['headerStyle', 'bodyStyle', 'totalsStyle']) { if (plan[key] !== undefined) { const failure = validateStyle(plan[key], key); if (failure) return failure } }
  for (const [index, entry] of (plan.columns ?? []).entries()) { if (typeOf(entry) !== 'object' || !Number.isInteger(entry.col) || entry.col < 0) return `columns[${index}].col is invalid`; const failure = validateStyle(entry.style, `columns[${index}].style`); if (failure) return failure }
  if (plan.freezeRows !== undefined && plan.freezeRows !== null && (!Number.isInteger(plan.freezeRows) || plan.freezeRows < 0)) return 'freezeRows is invalid'
  for (const [index, entry] of (plan.columnWidths ?? []).entries()) if (typeOf(entry) !== 'object' || !Number.isInteger(entry.col) || entry.col < 0 || !Number.isInteger(entry.width) || entry.width < 30 || entry.width > 600) return `columnWidths[${index}] is invalid`
  if (plan.autoFitColumns !== undefined && typeof plan.autoFitColumns !== 'boolean') return 'autoFitColumns must be boolean'
  return null
}

export function validateAction(plan) {
  if (typeOf(plan) !== 'object' || typeof plan.type !== 'string') return { ok: false, error: 'INVALID_RESPONSE: action must be an object with a type' }
  if (plan.type === ACTION_TYPES.CLARIFY) return typeof plan.question === 'string' && Object.keys(plan).every(key => ['type', 'question'].includes(key)) ? { ok: true, value: plan } : { ok: false, error: 'INVALID_RESPONSE: clarify requires only a question' }
  if (plan.type === ACTION_TYPES.QUERY) { const failure = validateQuery(plan); return failure ? { ok: false, error: `INVALID_RESPONSE: ${failure}` } : { ok: true, value: plan } }
  if (plan.type === ACTION_TYPES.FORMAT_SHEET) { const failure = validateFormat(plan); return failure ? { ok: false, error: `INVALID_RESPONSE: ${failure}` } : { ok: true, value: plan } }
  return { ok: false, error: `INVALID_RESPONSE: unsupported action type ${plan.type}` }
}

export function parseAndValidateAction(text) {
  try {
    const raw = extractFirstJsonObject(text)
    const parsed = JSON.parse(raw)
    // Some OpenAI-compatible providers wrap the requested action in an
    // `action` property even when the prompt asks for the action itself.
    const action = typeOf(parsed) === 'object' && typeof parsed.type !== 'string' && typeOf(parsed.action) === 'object'
      ? parsed.action
      : parsed
    return validateAction(action)
  } catch (error) {
    return { ok: false, error: error.message?.startsWith('INVALID_RESPONSE') ? error.message : `INVALID_RESPONSE: ${error.message}` }
  }
}
