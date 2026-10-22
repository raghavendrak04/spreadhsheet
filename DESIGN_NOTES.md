# Design notes

## Challenges

- **1 — Range selection and fill:** Selection is an anchor/focus rectangle in React. The engine implements transactional range clear, range styles, and fill series for copied values, number/text suffix sequences, dates, weekdays/months, and shifted formulas. Formula transformation supports relative, absolute, and mixed references.
- **2 — Sort and filter:** Filters are an engine-derived visible-row view; they do not affect formula values. Sorting is an atomic physical operation with stable comparisons, original row identity, totals-row protection, and visible-row-only sorting while a filter is active.
- **3 — Virtual grid:** The engine is sparse and starts at 100,000 × 200 bounds. React calculates row/column prefix sums and binary-searches the visible window with overscan. The grid fixes the first row/column, supports dimensions, auto-fit, name-box jumps, keyboard navigation, and far-scroll edits without React state per cell.
- **4 — Ask your data:** `Ctrl+K` opens a panel. A provider produces raw text; local code extracts and validates one JSON action, then runs valid `query` plans over local sheet data. Re-run does not call the provider; insert is one engine transaction.
- **5 — Format with AI:** `format_sheet` actions receive a local preview. Apply is one engine transaction, while discard does nothing. Number/date formats alter only display values; stored raw cell values are retained.

## Data model changes

- Sparse `Map<A1, { raw }>` retains only non-empty cells.
- Engine-owned `Map<A1, CellStyle>` stores styles and number formats, so styles move with fill/structure changes and participate in undo.
- Stable row/column IDs, row heights, column widths, and `frozenRows` are engine state.
- Filter definitions are engine state and return a visible-row projection.
- Every mutation captures one before/after transaction state for undo/redo. Bulk actions therefore revert in one `Ctrl+Z`.

## Engine API

- `getCell(row, col)` / `getDisplayCell(row, col)` — read raw/computed/display values; read-only.
- `getUsedRange()` / `getVisibleRows(startRow, endRow)` / `getTableSnapshot()` — read engine data; read-only.
- `setCell`, `setRange`, `loadMatrix` — write cells atomically; one undo restores the affected data.
- `clearRange(range)` — clears a rectangle; one undo restores it.
- `fillRange(seedRange, targetRange)` — fills content and seed style; one undo restores the pre-fill state.
- `setRangeStyle(range, patch)` — formats a rectangle; one undo restores prior styles.
- `insertRow`, `deleteRow`, `insertColumn`, `deleteColumn` — structural changes with style/formula shifting; one undo restores the prior structure.
- `setFilter`, `clearFilter`, `clearAllFilters`, `sortRange` — filter view management and physical sort. Sort is one undo; filter changes are view-only.
- `setColumnWidth`, `setRowHeight`, `autoFitColumns`, `setFrozenRows` — dimensions/freeze updates, each reversible if changed.
- `applyFormat(plan)` — deterministic format action. Returns `APPLIED`, `NO_CHANGES`, or `OUT_OF_RANGE`; only `APPLIED` creates one undo entry.
- `insertTable(at, result)` — writes a query table including headers; one undo clears/restores that insertion.

## Undo semantics

- Cell editing, range clearing, fill, manual formatting, sort, structural change, query insertion, dimensions, frozen rows, and AI formatting are each one transaction.
- `NO_CHANGES` and rejected `OUT_OF_RANGE` format actions do not create an undo entry.
- Redo restores the exact captured after-state for the transaction.

## Defects found in the existing code

- `src/App.jsx` rendered a fixed 50 × 50 table and kept each style in React state. It could not meet the required scale and styles could not be reliably moved/undone. Replaced with a virtualized viewport backed by engine metadata.
- `src/App.jsx` started editing on the first click. The required behaviour separates selection from editing. The new UI uses first-click selection and double-click/Enter/F2/typing to edit.
- `src/engine/core.js` did not parse `$` references. The new formula parser and reference transformer handle `$A$1`, `$A1`, and `A$1`.
- `src/ai/provider.js` deliberately threw for HTTP mode. It now implements a vendor-neutral OpenAI-compatible message request through plain `fetch`, while mock mode stays the default.
- The prior code had no query executor, format applier, JSON extraction, schema validation, filter view, sort implementation, or bulk transactional API.

## Measurements

- Commands verified locally: `npm test` (14 passing tests), `npm run lint` (passes), and `npm run build` (passes).
- Engine microbenchmark, Node 24 on this workstation, 10,001 loaded rows: 5,000-cell fill **42.96 ms**; 10,000-row sort **156.17 ms**. This is an engine benchmark, not a browser production-profile claim.
- Query microbenchmark, Node 24: two-level group-by over 100,000 generated rows **168.85 ms**; representative large-fixture grouped query **22.48 ms**.
- `npm run build` completed successfully. Browser frame/first-paint measurements and the requested recording must be captured on the submission machine: local-browser automation was disabled in this workspace, so those values are intentionally not fabricated.

## AI

- Default provider: deterministic offline mock from `fixtures/ai-eval/`; the UI works without a key. HTTP mode reads `VITE_AI_ENDPOINT`, `VITE_AI_API_KEY`, and `VITE_AI_MODEL` from `.env.local` and uses `fetch` only.
- Context sent to a provider: used range; data-row count; exact headers; `{ name, index, inferredType, examples }` per column; at most five sample rows; current selected range; totals-row flag. The complete table is never sent.
- The parser finds the first complete JSON object through prose/code fences. The validator rejects unknown fields, invalid enum values, bad nested style definitions, and unsupported action types before executing anything.
- Invalid JSON/schema failures return `INVALID_RESPONSE` and do not change the sheet. Provider/network/auth/rate-limit failures are surfaced in the panel. A non-query action is not passed to the query executor. Unknown columns return `UNKNOWN_COLUMN` rather than a guessed column.
- All valid query golden plans on `sales-large.tsv` are tested against `fixtures/ai-eval/queries.json`. Representative formatting golden cases are tested in `src/ai/ai.test.js`.

## Trade-offs and what I would do next

- The virtualizer uses simple prefix-sum arrays recalculated after engine mutations; a large app could use a Fenwick tree for faster frequent size updates.
- Sort formula remapping handles relative positions; broader Excel-compatible structured references and cross-sheet semantics are intentionally out of scope.
- The HTTP provider is an OpenAI-compatible request shape. A production deployment should place it behind a server proxy so browser-delivered Vite variables never expose a secret.
- The challenge instructions conflict on submission format (one PR/recording versus one per challenge). Confirm this before publishing.
- Capture browser performance traces and all required screen recordings before submission.

## Use of AI tools

- Used an AI coding assistant to analyse the requirements, design the engine/UI separation, implement the local features, and generate/extend tests. The final code remains explainable through the module boundaries and this document.
