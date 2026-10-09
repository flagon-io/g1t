/** Micro-dollars as people read them: "$0.14", "$12.50", "$1,204". */
export function dollars(micros: number): string {
  const value = Math.max(0, micros) / 1_000_000;
  if (value >= 1000) return `$${Math.round(value).toLocaleString("en-US")}`;
  if (value > 0 && value < 0.01) return "<$0.01";
  return `$${value.toFixed(2)}`;
}
