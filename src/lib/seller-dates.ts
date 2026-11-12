export type SellerPreset = 'today' | 'yesterday' | 'week' | 'month';

/** The server's YYYY-MM-DD is authoritative, including its business timezone. */
export function sellerPresetDates(today: string, preset: SellerPreset) {
  const [year, month, day] = today.split('-').map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  const format = (value: Date) => value.toISOString().slice(0, 10);
  if (preset === 'yesterday') { date.setUTCDate(date.getUTCDate() - 1); return { from: format(date), to: format(date) }; }
  if (preset === 'week') { date.setUTCDate(date.getUTCDate() - (date.getUTCDay() || 7) + 1); return { from: format(date), to: today }; }
  if (preset === 'month') return { from: `${today.slice(0, 7)}-01`, to: today };
  return { from: today, to: today };
}
