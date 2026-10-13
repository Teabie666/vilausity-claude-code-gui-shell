/**
 * Price rules and the problems of a pasted answer, written out for the providers editor (its
 * preview of a paste, the rules of a model's row).
 */

import type { Currency, PriceRule, PriceWhen, Prices, PricingProblem } from '../../platform/pricing';
import { t } from './messages';

const tokens = new Intl.NumberFormat('en-US');

/** 1-2-3-4-5 as "Mon–Fri", 1-3 as "Mon, Wed". */
function daysText(days: readonly number[]): string {
  const names = t('weekdays').split(',');
  const runs: string[] = [];
  for (let index = 0; index < days.length;) {
    let end = index;
    while (end + 1 < days.length && days[end + 1] === days[end] + 1) {
      end++;
    }
    const first = names[days[index] - 1] ?? String(days[index]);
    const last = names[days[end] - 1] ?? String(days[end]);
    runs.push(end - index >= 2 ? `${first}–${last}` : end > index ? `${first}, ${last}` : first);
    index = end + 1;
  }
  return runs.join(', ');
}

function rangeText(over: number | undefined, upTo: number | undefined): string {
  return [over === undefined ? '' : `> ${tokens.format(over)}`, upTo === undefined ? '' : `≤ ${tokens.format(upTo)}`]
    .filter(Boolean)
    .join(' ');
}

/** "Mon–Fri 00:30–08:30 (Asia/Shanghai) · input > 32,000 ≤ 128,000 · thinking" */
export function whenText(when: PriceWhen): string {
  const parts: string[] = [];
  const time = [
    when.days ? daysText(when.days) : '',
    when.from !== undefined && when.to !== undefined ? `${when.from}–${when.to}` : '',
    when.startDate && when.endDate
      ? t('ruleDates', when.startDate, when.endDate)
      : when.startDate
        ? t('ruleSince', when.startDate)
        : when.endDate
          ? t('ruleUntil', when.endDate)
          : '',
  ]
    .filter(Boolean)
    .join(' ');
  if (time) {
    parts.push(when.zone ? `${time} (${when.zone})` : time);
  }
  if (when.inputOver !== undefined || when.inputUpTo !== undefined) {
    parts.push(t('ruleInput', rangeText(when.inputOver, when.inputUpTo)));
  }
  if (when.outputOver !== undefined || when.outputUpTo !== undefined) {
    parts.push(t('ruleOutput', rangeText(when.outputOver, when.outputUpTo)));
  }
  if (when.thinking !== undefined) {
    parts.push(when.thinking ? t('ruleThinking') : t('ruleNotThinking'));
  }
  if (when.exceptHolidays === 'CN') {
    parts.push(t('ruleExceptHolidaysCN'));
  }
  return parts.join(' · ');
}

/** "¥2 / ¥0.2 / — / ¥8": input, cache hit, cache write, output (the table's columns). */
export function pricesText(prices: Prices, currency: Currency): string {
  const symbol = currency === 'CNY' ? '¥' : '$';
  const price = (value: number | undefined): string => (value === undefined ? '—' : `${symbol}${value}`);
  return [price(prices.input), price(prices.cacheRead), price(prices.cacheWrite), price(prices.output)].join(' / ');
}

/** "Off-peak: Mon–Fri 00:30–08:30 (Asia/Shanghai) → ¥1 / ¥0.1 / — / ¥4" */
export function ruleText(rule: PriceRule, currency: Currency): string {
  return `${rule.label}: ${whenText(rule.when)} → ${pricesText(rule, currency)}`;
}

export function problemText(problem: PricingProblem): string {
  const detail = problem.detail ?? '';
  const messages: Record<PricingProblem['code'], () => string> = {
    cannotBrowse: () => t('problemCannotBrowse'),
    noJson: () => t('problemNoJson'),
    badJson: () => t('problemBadJson', detail),
    notObject: () => t('problemNotObject'),
    unknownKey: () => t('problemUnknownKey', detail),
    missing: () => t('problemMissing'),
    notNumber: () => t('problemNotNumber', detail),
    notInteger: () => t('problemNotInteger', detail),
    notString: () => t('problemNotString', detail),
    notBoolean: () => t('problemNotBoolean', detail),
    badCurrency: () => t('problemBadCurrency', detail),
    badZone: () => t('problemBadZone', detail),
    zoneNeeded: () => t('problemZoneNeeded'),
    badDays: () => t('problemBadDays', detail),
    badTime: () => t('problemBadTime', detail),
    timePair: () => t('problemTimePair'),
    badDate: () => t('problemBadDate', detail),
    badRange: () => t('problemBadRange', detail),
    emptyWhen: () => t('problemEmptyWhen'),
    badHolidays: () => t('problemBadHolidays', detail),
    noModels: () => t('problemNoModels'),
  };
  const message = messages[problem.code]();
  return problem.path ? `${problem.path}: ${message}` : message;
}
