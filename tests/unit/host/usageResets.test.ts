import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import { formatResetTime } from '../../../src/host/webview/usageResets';

// Monday 12 October 2026, 09:00 local time.
const now = new Date(2026, 9, 12, 9, 0).getTime();
const at = (day: number, hour: number, minute: number): number => new Date(2026, 9, day, hour, minute).getTime();

describe('formatResetTime', () => {
  test('today: the time alone, 24-hour', () => {
    assert.equal(formatResetTime(at(12, 15, 42), now, 'en'), '15:42');
    assert.equal(formatResetTime(at(12, 15, 42), now, 'zh-CN'), '15:42');
  });

  test('tomorrow, then a weekday within the week, then a date', () => {
    assert.equal(formatResetTime(at(13, 9, 5), now, 'en'), 'tomorrow 09:05');
    assert.equal(formatResetTime(at(13, 9, 5), now, 'zh-CN'), '明天 09:05');
    assert.equal(formatResetTime(at(15, 9, 5), now, 'en'), 'Thu 09:05');
    assert.equal(formatResetTime(at(15, 9, 5), now, 'zh-CN'), '周四 09:05');
    assert.equal(formatResetTime(at(22, 9, 5), now, 'en'), 'Oct 22 09:05');
    assert.equal(formatResetTime(at(22, 9, 5), now, 'zh-CN'), '10月22日 09:05');
  });
});
