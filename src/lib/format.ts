// One place for number formatting, so dashboard and posters always match.

// Decimal stats (hours, ratios, percentages) always show 2 decimal places.
export function formatDecimal(n: number): string {
  return n.toFixed(2);
}

// Whole numbers get thousands separators: 48210 -> "48,210".
export function formatInt(n: number): string {
  return n.toLocaleString("en-US");
}
