/**
 * What the session list's usage block shows (`usage.view`): the tokens a provider's calls
 * used, in three scopes (platform/usage.ts), priced with its prices and written out in the
 * display language.
 */

import type { UsageTotalDto, UsageViewDto } from '../../platform/protocol';
import type { Currency, ProviderPricing } from '../../platform/providers';
import { modelCost, totalCost, type ModelTokens, type UsageScopes } from '../../platform/usage';
import { t } from './messages';

const SCOPES = [
  ['session', () => t('usageSession')],
  ['folder', () => t('usageFolder')],
  ['all', () => t('usageAll')],
] as const;

export function formatCost(cost: number, currency: Currency): string {
  const symbol = currency === 'CNY' ? '¥' : '$';
  if (cost === 0) {
    return `${symbol}0`;
  }
  return cost < 0.01 ? `<${symbol}0.01` : `${symbol}${cost.toFixed(2)}`;
}

const compact = new Intl.NumberFormat('en-US', { notation: 'compact', maximumFractionDigits: 1 });

/** 36.1k, 1.2m, as the extension writes token counts. */
export function formatTokens(count: number): string {
  return compact.format(count).toLowerCase();
}

/** A scope's cost: "—" with nothing to show, "≥ ¥3.40" while some of its models have no price. */
export function scopeValue(models: ModelTokens, pricing: ProviderPricing | undefined, currency: Currency): string {
  const { cost, unpriced } = totalCost(models, pricing);
  const used = Object.keys(models).length;
  if (used === 0) {
    return formatCost(0, currency);
  }
  if (unpriced.length === used) {
    return '—';
  }
  return unpriced.length > 0 ? `≥ ${formatCost(cost, currency)}` : formatCost(cost, currency);
}

function scopeDetail(models: ModelTokens, pricing: ProviderPricing | undefined, currency: Currency): string {
  const lines = Object.entries(models)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([model, tokens]) => {
      const counts = t(
        'usageTokens',
        formatTokens(tokens.input),
        formatTokens(tokens.output),
        formatTokens(tokens.cacheRead),
        formatTokens(tokens.cacheWrite),
        String(tokens.calls),
      );
      const cost = modelCost(model, tokens, pricing);
      // The calls its rules priced (the rest at its own prices).
      const rules = Object.entries(tokens.rules ?? {}).map(([label, calls]) => `  ${t('usageRuleCalls', label, String(calls))}`);
      // Of its tokens, those of the calls Claude Code made for itself.
      const own = tokens.unrecorded
        ? [
            `  ${t(
              'usageUnrecorded',
              formatTokens(tokens.unrecorded.input),
              formatTokens(tokens.unrecorded.output),
              formatTokens(tokens.unrecorded.cacheRead),
              formatTokens(tokens.unrecorded.cacheWrite),
            )}`,
          ]
        : [];
      return [`${model}: ${counts} · ${cost === undefined ? t('usageNoPrice') : formatCost(cost, currency)}`, ...own, ...rules].join('\n');
    });
  return lines.length > 0 ? lines.join('\n') : t('usageNone');
}

/** A provider's total in the providers editor (`usage.total`). */
export function usageTotal(models: ModelTokens, pricing: ProviderPricing | undefined): UsageTotalDto {
  const currency = pricing?.currency ?? 'USD';
  return { value: scopeValue(models, pricing, currency), detail: scopeDetail(models, pricing, currency) };
}

/** The block for a provider named `name`; `hasSession`: there is a conversation in front. */
export function usageView(scopes: UsageScopes, name: string, pricing: ProviderPricing | undefined, hasSession: boolean): UsageViewDto {
  const currency = pricing?.currency ?? 'USD';
  const unpriced = totalCost(scopes.all, pricing).unpriced;
  return {
    title: t('usageTitle', name),
    tooltip: t('usageTooltip'),
    editPrices: t('usagePrices'),
    editPricesTitle: t('usagePricesTitle'),
    rows: SCOPES.map(([scope, label]) => {
      const models = scopes[scope];
      const none = scope === 'session' && !hasSession;
      return {
        label: label(),
        value: none ? '—' : scopeValue(models, pricing, currency),
        detail: none ? t('usageNone') : scopeDetail(models, pricing, currency),
      };
    }),
    unpriced: unpriced.length > 0 ? t('usageUnpriced', unpriced.join(', ')) : undefined,
    caveat: t('usageCaveat'),
  };
}
