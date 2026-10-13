import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { holidayYears, isHoliday, isHolidayCalendar } from '../../../src/platform/holidays';

describe('isHoliday', () => {
  test("mainland China's days off of 2026, first and last days included", () => {
    for (const date of [
      '2026-01-01',
      '2026-01-03',
      '2026-02-15',
      '2026-02-23',
      '2026-04-06',
      '2026-05-05',
      '2026-06-19',
      '2026-09-27',
      '2026-10-01',
      '2026-10-07',
    ]) {
      assert.equal(isHoliday('CN', date), true, date);
    }
    for (const date of ['2026-01-04', '2026-02-14', '2026-02-24', '2026-05-06', '2026-10-08', '2026-10-10', '2026-12-31']) {
      assert.equal(isHoliday('CN', date), false, date);
    }
  });

  test('a year with no schedule has no holidays', () => {
    assert.equal(isHoliday('CN', '2027-10-01'), false);
    assert.deepEqual(holidayYears('CN'), [2026]);
  });

  test('knows only the calendars it has', () => {
    assert.equal(isHolidayCalendar('CN'), true);
    assert.equal(isHolidayCalendar('US'), false);
    assert.equal(isHolidayCalendar(undefined), false);
  });
});
