import { describe, expect, it } from 'vitest';
import { sellerPresetDates } from '../seller-dates';

describe('seller report uses the backend business day, not the device date', () => {
  it('matches web presets across month/year and week boundaries', () => {
    expect(sellerPresetDates('2026-11-11', 'today')).toEqual({from:'2026-11-11',to:'2026-11-11'});
    expect(sellerPresetDates('2026-01-01', 'yesterday')).toEqual({from:'2025-12-31',to:'2025-12-31'});
    expect(sellerPresetDates('2026-11-15', 'week')).toEqual({from:'2026-11-09',to:'2026-11-15'});
    expect(sellerPresetDates('2026-11-11', 'month')).toEqual({from:'2026-11-01',to:'2026-11-11'});
  });
});
