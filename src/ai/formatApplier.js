export function describeFormatPlan(plan) {
  const parts = []
  if (plan.clearFormatting) parts.push('clear existing formatting')
  if (plan.headerStyle) parts.push(`header: ${Object.entries(plan.headerStyle).map(([key, value]) => `${key} ${value}`).join(', ')}`)
  if (plan.bodyStyle) parts.push(`body: ${Object.entries(plan.bodyStyle).map(([key, value]) => `${key} ${value}`).join(', ')}`)
  if (plan.columns?.length) parts.push(`${plan.columns.length} column style${plan.columns.length === 1 ? '' : 's'}`)
  if (plan.totalsStyle) parts.push('totals row style')
  if (typeof plan.freezeRows === 'number') parts.push(plan.freezeRows ? `freeze ${plan.freezeRows} row${plan.freezeRows === 1 ? '' : 's'}` : 'unfreeze rows')
  if (plan.columnWidths?.length) parts.push(`${plan.columnWidths.length} column width${plan.columnWidths.length === 1 ? '' : 's'}`)
  if (plan.autoFitColumns) parts.push('auto-fit columns')
  return parts.length ? parts.join('; ') : 'No formatting changes requested.'
}

export function previewFormat(engine, plan) {
  const used = engine.getUsedRange()
  if (typeof plan.freezeRows === 'number' && plan.freezeRows >= used.rowCount) return { error: 'OUT_OF_RANGE', detail: 'Cannot freeze every used row.' }
  return { description: describeFormatPlan(plan), usedRange: used }
}

export function applyFormat(engine, plan) {
  return engine.applyFormat(plan)
}
