/**
 * Public holidays that some API prices leave out: a price rule with `exceptHolidays` does not
 * hold on them (DeepSeek's peak hours are off-peak all day on mainland China's public holidays).
 * The days are each year's days off as officially published. A year not listed has none, so
 * its rules hold every day: add a year when its schedule comes out (mainland China's in
 * November of the year before).
 */

export type HolidayCalendar = 'CN';

export const HOLIDAY_CALENDARS: readonly HolidayCalendar[] = ['CN'];

/**
 * Mainland China: the days off of the State Council's schedule, "MM-DD" first and last
 * (2026: 国务院办公厅关于2026年部分节假日安排的通知, 2025-11-04). The weekend days it makes
 * working days are not here: the rules this is for already leave weekends out.
 */
const CN: Readonly<Record<number, readonly (readonly [string, string])[]>> = {
  2026: [
    ['01-01', '01-03'],
    ['02-15', '02-23'],
    ['04-04', '04-06'],
    ['05-01', '05-05'],
    ['06-19', '06-21'],
    ['09-25', '09-27'],
    ['10-01', '10-07'],
  ],
};

const CALENDARS: Readonly<Record<HolidayCalendar, Readonly<Record<number, readonly (readonly [string, string])[]>>>> = { CN };

export function isHolidayCalendar(value: unknown): value is HolidayCalendar {
  return typeof value === 'string' && (HOLIDAY_CALENDARS as readonly string[]).includes(value);
}

/** Whether a local date, "YYYY-MM-DD", is a holiday of `calendar`. */
export function isHoliday(calendar: HolidayCalendar, date: string): boolean {
  const days = CALENDARS[calendar][Number(date.slice(0, 4))];
  const day = date.slice(5);
  return days?.some(([first, last]) => day >= first && day <= last) === true;
}

/** The years `calendar` knows the holidays of. */
export function holidayYears(calendar: HolidayCalendar): number[] {
  return Object.keys(CALENDARS[calendar]).map(Number);
}
