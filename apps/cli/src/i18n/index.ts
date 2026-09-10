/**
 * i18n 导出入口 - 翻译逻辑
 *
 * Provider / Hook 已被 state/i18n-store.ts 取代（TUI 版不再依赖 React Context）。
 */

export { getTranslation, normalizeLanguageCode } from './translations';
export type { LanguageCode, TranslationKeys, InterpolationParams, TranslateFn } from './types';
