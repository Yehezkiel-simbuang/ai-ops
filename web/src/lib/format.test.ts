import { ago, dateInputToMs, dateStr, dueText, fileSafe, fmt, usd } from './format';

const NOW = Date.UTC(2026, 5, 15, 12, 0, 0);

describe('format', () => {
  it('ago memilih satuan yang tepat', () => {
    expect(ago(null)).toBe('belum pernah');
    expect(ago(NOW - 5_000, NOW)).toBe('5 dtk lalu');
    expect(ago(NOW - 5 * 60_000, NOW)).toBe('5 mnt lalu');
    expect(ago(NOW - 3 * 3_600_000, NOW)).toBe('3 jam lalu');
    expect(ago(NOW - 2 * 86_400_000, NOW)).toBe('2 hari lalu');
  });
  it('dueText membedakan terlambat, hari ini, dan mendatang', () => {
    expect(dueText(NOW - 3 * 86_400_000, NOW)).toBe('terlambat 3 hari');
    expect(dueText(NOW, NOW)).toBe('hari ini');
    expect(dueText(NOW + 5 * 86_400_000, NOW)).toBe('5 hari lagi');
  });
  it('usd menyembunyikan biaya yang tidak diketahui dan memilih presisi', () => {
    expect(usd(0.123456, false)).toBe('-');
    expect(usd(0.123456, true)).toBe('$0.1235');
    expect(usd(12.3456, true)).toBe('$12.35');
  });
  it('dateStr, fmt, dateInputToMs, fileSafe', () => {
    expect(dateStr(NOW)).toBe('2026-06-15');
    expect(dateStr(null)).toBe('-');
    expect(fmt(null)).toBe('0');
    expect(dateInputToMs('')).toBeUndefined();
    expect(new Date(dateInputToMs('2026-06-15')!).getHours()).toBe(9);
    expect(fileSafe('srv db/1 ../x')).toBe('srv_db_1_.._x');
  });
});
