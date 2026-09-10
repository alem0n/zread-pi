/**
 * I18nStore - 翻译状态（替代原 I18nProvider + useI18n）
 *
 * 语义与迁移前一致：
 * - 启动时读取 ~/.zread/config.yaml 的 language 字段
 * - setLanguage 热切换界面语言（ConfigLanguagePage 用）
 * - 未知 key 返回空字符串（与 useI18n 相同）
 */

import type { LanguageCode, TranslationKeys, InterpolationParams } from "../i18n/types";
import { getTranslation } from "../i18n/translations";
import { zhCN } from "../i18n/translations/zh-CN";

/** 获取嵌套对象的值 */
function getNestedValue(obj: Record<string, unknown>, path: string): string | undefined {
  const keys = path.split(".");
  let current: unknown = obj;

  for (const key of keys) {
    if (current && typeof current === "object" && key in current) {
      current = (current as Record<string, unknown>)[key];
    } else {
      return undefined;
    }
  }

  return typeof current === "string" ? current : undefined;
}

/** 插值替换 {param} */
function interpolate(template: string, params: InterpolationParams): string {
  return template.replace(/\{(\w+)\}/g, (_, key) => String(params[key] ?? `{${key}}`));
}

export class I18nStore {
  language: LanguageCode = "zh-CN";
  private translations: TranslationKeys = zhCN;

  setLanguage(language: LanguageCode): void {
    this.language = language;
    this.translations = getTranslation(language);
  }

  t(key: string, params?: InterpolationParams): string {
    const template = getNestedValue(
      this.translations as unknown as Record<string, unknown>,
      key,
    );

    if (template === undefined) {
      return "";
    }

    return params ? interpolate(template, params) : template;
  }
}
