// Lines of code, with outliers removed. A commit touching thousands of lines
// is almost always a lockfile, generated code, or a vendored library, and one
// `npm install` shouldn't make someone look like a 10x engineer.
// Raw numbers stay in the database, so this threshold can change anytime.
export const OUTLIER_LINES = 5000;

export function linesOfCode(commits: { lines_added: number | null; lines_removed: number | null }[]) {
  let added = 0;
  let removed = 0;
  for (const c of commits) {
    if (c.lines_added == null || c.lines_removed == null) continue; // day-level rows have no lines
    if (c.lines_added + c.lines_removed > OUTLIER_LINES) continue;
    added += c.lines_added;
    removed += c.lines_removed;
  }
  return { added, removed };
}
