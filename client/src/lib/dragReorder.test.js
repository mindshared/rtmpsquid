import { describe, it, expect } from 'vitest';
import { targetIndexFromPointer } from './dragReorder';

// Three 40px-tall rows stacked from y=0 (midpoints at 20, 60, 100).
const rows = [
  { index: 0, top: 0, bottom: 40 },
  { index: 1, top: 40, bottom: 80 },
  { index: 2, top: 80, bottom: 120 },
];

describe('targetIndexFromPointer', () => {
  it('returns null when there are no rows', () => {
    expect(targetIndexFromPointer(50, [])).toBeNull();
    expect(targetIndexFromPointer(50, null)).toBeNull();
  });

  it('targets a row while the pointer is above its midpoint', () => {
    expect(targetIndexFromPointer(0, rows)).toBe(0);
    expect(targetIndexFromPointer(19, rows)).toBe(0);
  });

  it('moves to the next row once past the midpoint', () => {
    expect(targetIndexFromPointer(20, rows)).toBe(1); // exactly the first midpoint
    expect(targetIndexFromPointer(59, rows)).toBe(1);
    expect(targetIndexFromPointer(60, rows)).toBe(2);
  });

  it('clamps to the last row below the final midpoint', () => {
    expect(targetIndexFromPointer(100, rows)).toBe(2);
    expect(targetIndexFromPointer(99999, rows)).toBe(2);
  });

  it('respects each row\'s own index (not array position)', () => {
    const sparse = [
      { index: 3, top: 0, bottom: 40 },
      { index: 7, top: 40, bottom: 80 },
    ];
    expect(targetIndexFromPointer(10, sparse)).toBe(3);
    expect(targetIndexFromPointer(70, sparse)).toBe(7);
  });
});
