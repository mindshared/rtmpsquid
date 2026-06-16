// @ts-check
// Pure hit-testing for pointer-driven (touch + mouse) queue reordering. Kept free
// of React/DOM so it's trivially unit-testable: given the pointer's Y and the
// on-screen rows, decide which queue index the drag is currently over.

/**
 * @typedef {{ index: number, top: number, bottom: number }} RowRect
 */

/**
 * Pick the target queue index for a pointer at vertical position `y`.
 * Rows are taken in visual order. The pointer "targets" the first row whose
 * midpoint it hasn't passed; past the last midpoint it targets the last row.
 * Returns null when there are no rows.
 *
 * @param {number} y - pointer clientY
 * @param {RowRect[]} rows - visible rows in order
 * @returns {number|null}
 */
export function targetIndexFromPointer(y, rows) {
  if (!rows || rows.length === 0) return null;
  for (const r of rows) {
    if (y < (r.top + r.bottom) / 2) return r.index;
  }
  return rows[rows.length - 1].index;
}
