// Self-contained Jalali (Persian/Shamsi) ↔ Gregorian calendar utilities.
// The conversion algorithm is the standard Khazaeli/Borna implementation
// used across the Iranian developer ecosystem; it's exact for all dates
// in the supported range (~years 1..3000 Gregorian) and needs no deps.

export type JDate = { jy: number; jm: number; jd: number };
export type GDate = { gy: number; gm: number; gd: number };

export const JALALI_MONTHS_FA = [
  'فروردین', 'اردیبهشت', 'خرداد', 'تیر', 'مرداد', 'شهریور',
  'مهر', 'آبان', 'آذر', 'دی', 'بهمن', 'اسفند',
];
// Persian week starts on Saturday. JS Date.getDay(): 0=Sun..6=Sat.
// Persian index: Sat=0, Sun=1, Mon=2, Tue=3, Wed=4, Thu=5, Fri=6.
export const JALALI_WEEKDAYS_FA = ['ش', 'ی', 'د', 'س', 'چ', 'پ', 'ج'];
export const JALALI_WEEKDAYS_FA_LONG = [
  'شنبه', 'یکشنبه', 'دوشنبه', 'سه‌شنبه', 'چهارشنبه', 'پنج‌شنبه', 'جمعه',
];
const PERSIAN_DIGITS = '۰۱۲۳۴۵۶۷۸۹';

export function toPersianDigits(s: string | number): string {
  return String(s).replace(/[0-9]/g, d => PERSIAN_DIGITS[Number(d)]);
}

export function gregorianToJalali(gy: number, gm: number, gd: number): JDate {
  const gDaysInMonth = [0, 31, 59, 90, 120, 151, 181, 212, 243, 273, 304, 334];
  let jy = gy <= 1600 ? 0 : 979;
  const _gy = gy <= 1600 ? gy - 621 : gy - 1600;
  const gy2 = gm > 2 ? _gy + 1 : _gy;
  let days = 365 * _gy + Math.floor((gy2 + 3) / 4) - Math.floor((gy2 + 99) / 100)
    + Math.floor((gy2 + 399) / 400) - 80 + gd + gDaysInMonth[gm - 1];
  jy += 33 * Math.floor(days / 12053);
  days %= 12053;
  jy += 4 * Math.floor(days / 1461);
  days %= 1461;
  if (days > 365) { jy += Math.floor((days - 1) / 365); days = (days - 1) % 365; }
  const jm = days < 186 ? 1 + Math.floor(days / 31) : 7 + Math.floor((days - 186) / 30);
  const jd = days < 186 ? 1 + (days % 31) : 1 + ((days - 186) % 30);
  return { jy, jm, jd };
}

export function jalaliToGregorian(jy: number, jm: number, jd: number): GDate {
  let gy = jy <= 979 ? 621 : 1600;
  const _jy = jy <= 979 ? jy : jy - 979;
  let days = 365 * _jy + Math.floor(_jy / 33) * 8 + Math.floor(((_jy % 33) + 3) / 4)
    + 78 + jd + (jm < 7 ? (jm - 1) * 31 : (jm - 7) * 30 + 186);
  gy += 400 * Math.floor(days / 146097);
  days %= 146097;
  if (days > 36524) { gy += 100 * Math.floor(--days / 36524); days %= 36524; if (days >= 365) days++; }
  gy += 4 * Math.floor(days / 1461);
  days %= 1461;
  if (days > 365) { gy += Math.floor((days - 1) / 365); days = (days - 1) % 365; }
  const gd = days + 1;
  const isLeap = (gy % 4 === 0 && gy % 100 !== 0) || (gy % 400 === 0);
  const monthLengths = [0, 31, isLeap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  let gm = 1, rem = gd;
  for (; gm < 13; gm++) { if (rem <= monthLengths[gm]) break; rem -= monthLengths[gm]; }
  return { gy, gm, gd: rem };
}

// Days in a Jalali month (1..12). Months 1..6: 31, 7..11: 30, 12: 29 or 30 (leap).
export function daysInJalaliMonth(jy: number, jm: number): number {
  if (jm <= 6) return 31;
  if (jm <= 11) return 30;
  return isJalaliLeap(jy) ? 30 : 29;
}

// 33-year cycle leap rule: jy mod 33 ∈ {1,5,9,13,17,22,26,30}.
export function isJalaliLeap(jy: number): boolean {
  const r = ((jy % 33) + 33) % 33;
  return [1, 5, 9, 13, 17, 22, 26, 30].includes(r);
}

// Build a UTC Date from a Jalali (jy,jm,jd) at the given UTC hour/min/sec/ms.
export function jalaliToUtcDate(jy: number, jm: number, jd: number, h = 0, mi = 0, s = 0, ms = 0): Date {
  const { gy, gm, gd } = jalaliToGregorian(jy, jm, jd);
  return new Date(Date.UTC(gy, gm - 1, gd, h, mi, s, ms));
}

// Today's date in the Jalali calendar (using the user's local timezone).
export function todayJalali(): JDate {
  const now = new Date();
  return gregorianToJalali(now.getFullYear(), now.getMonth() + 1, now.getDate());
}

// Format a Jalali date as "1405/04/02" (English digits, fixed-width).
export function formatJalaliISO(d: JDate): string {
  return `${d.jy}/${String(d.jm).padStart(2, '0')}/${String(d.jd).padStart(2, '0')}`;
}

// Format with Persian digits and month name: "۲ تیر ۱۴۰۵".
export function formatJalaliLong(d: JDate): string {
  return `${toPersianDigits(d.jd)} ${JALALI_MONTHS_FA[d.jm - 1]} ${toPersianDigits(d.jy)}`;
}

// Persian weekday index (Sat=0..Fri=6) of the given Jalali date.
export function jalaliDow(d: JDate): number {
  const { gy, gm, gd } = jalaliToGregorian(d.jy, d.jm, d.jd);
  const jsDow = new Date(gy, gm - 1, gd).getDay(); // 0=Sun..6=Sat
  return (jsDow + 1) % 7;
}

// Build the 24-hex ObjectId whose embedded timestamp = the given Date's epoch seconds.
// Pads the remaining 16 hex chars with zeros so it serves as a sortable boundary
// for `_id >= ObjectId(...)` / `_id < ObjectId(...)` queries.
export function objectIdBoundary(date: Date): string {
  const secs = Math.floor(date.getTime() / 1000);
  return secs.toString(16).padStart(8, '0') + '0000000000000000';
}

// Compute the standard inclusive-start, exclusive-end boundaries for a Jalali range.
// Start is 00:00:00.000 UTC of the start day, end is 00:00:00.000 UTC of the day
// AFTER the end day, which is what MongoDB filters typically want: $gte start, $lt end.
export function jalaliRangeBoundaries(start: JDate, end: JDate): { startIso: string; endIso: string; startOid: string; endOid: string } {
  const s = jalaliToUtcDate(start.jy, start.jm, start.jd, 0, 0, 0, 0);
  const eDay = jalaliToUtcDate(end.jy, end.jm, end.jd, 0, 0, 0, 0);
  const e = new Date(eDay.getTime() + 86_400_000);
  return { startIso: s.toISOString(), endIso: e.toISOString(), startOid: objectIdBoundary(s), endOid: objectIdBoundary(e) };
}
