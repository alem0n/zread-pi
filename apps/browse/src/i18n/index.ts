/**
 * 翻译聚合导出 + key 查找 / 插值
 *
 * 语义与 CLI 侧的 apps/cli/src/i18n 对齐（点号分层 key、{param} 插值、
 * 未知 key 返回空字符串），但字典独立，供浏览站打包。
 */

import type { InterpolationParams, LanguageCode, TranslationKeys } from './types';
import { zhCN } from './zh-CN';
import { enUS } from './en-US';

export const translations: Record<LanguageCode, TranslationKeys> = {
  'zh-CN': zhCN,
  'en-US': enUS,
};

/**
 * 语言解析失败时的回退语言。
 * 用 en-US 而非 zh-CN：浏览站改造前全部是英文硬编码，回退到英文对现有用户零变化；
 * 真正的语言由 /api/i18n 在启动时下发。
 */
export const DEFAULT_LANGUAGE: LanguageCode = 'en-US';

/** 获取指定语言的翻译字典（未知语言回退默认语言） */
export function getTranslation(lang: LanguageCode): TranslationKeys {
  return translations[lang] ?? translations[DEFAULT_LANGUAGE];
}

/** 取嵌套对象的值（点号分层路径，如 trajectory.modes.sequence） */
function getNestedValue(obj: Record<string, unknown>, path: string): string | undefined {
  const keys = path.split('.');
  let current: unknown = obj;

  for (const key of keys) {
    if (current && typeof current === 'object' && key in current) {
      current = (current as Record<string, unknown>)[key];
    } else {
      return undefined;
    }
  }

  return typeof current === 'string' ? current : undefined;
}

/** 插值替换 {param}（缺失参数保留原占位符，便于排错） */
function interpolate(template: string, params: InterpolationParams): string {
  return template.replace(/\{(\w+)\}/g, (_, key) => String(params[key] ?? `{${key}}`));
}

/** 构造指定语言的翻译函数 */
export function createTranslate(lang: LanguageCode): (key: string, params?: InterpolationParams) => string {
  const dict = getTranslation(lang) as unknown as Record<string, unknown>;
  return (key: string, params?: InterpolationParams): string => {
    const template = getNestedValue(dict, key);
    if (template === undefined) return '';
    return params ? interpolate(template, params) : template;
  };
}

export type { LanguageCode, TranslationKeys, InterpolationParams } from './types';
