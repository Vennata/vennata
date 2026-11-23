// "True" meeting time: if two meetings overlap (double-booked, or the same
// meeting on Google and Zoom), the overlapping time only counts once.
//
// Algorithm (interval union): sort by start time, then walk through, merging
// each meeting into the current block if it starts before the block ends.
//   9:00-10:00 + 9:30-10:30  ->  9:00-10:30  = 1.5h, not 2h

export interface Interval {
  start: Date;
  end: Date;
}

export function mergeIntervals(intervals: Interval[]): Interval[] {
  const sorted = [...intervals].sort((a, b) => a.start.getTime() - b.start.getTime());
  const merged: Interval[] = [];

  for (const { start, end } of sorted) {
    const last = merged.at(-1);
    if (last && start <= last.end) {
      if (end > last.end) last.end = end; // extend the current block
    } else {
      merged.push({ start: new Date(start), end: new Date(end) }); // start a new block
    }
  }
  return merged;
}

export function totalHours(intervals: Interval[]): number {
  const ms = mergeIntervals(intervals).reduce(
    (sum, i) => sum + (i.end.getTime() - i.start.getTime()),
    0,
  );
  return ms / 3_600_000;
}
