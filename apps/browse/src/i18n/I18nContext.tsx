/**
 * I18nContext —— 浏览站语言状态。
 *
 * - 挂载时请求一次 /api/i18n（由 CLI 配置的 language 字段解析出 zh-CN / en-US）；
 * - 解析失败或请求未完成前沿用默认语言（en-US），不阻塞渲染；
 * - 通过 useI18n() 取 { locale, t }。
 *
 * 语言与 CLI 界面语言同源，用户在 CLI 配置界面切换语言后重新打开网页即生效。
 */

import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { i18nApi } from '@/utils/api';
import { createTranslate, DEFAULT_LANGUAGE } from './index';
import type { LanguageCode, TranslateFn } from './types';

interface I18nValue {
  locale: LanguageCode;
  t: TranslateFn;
}

const I18nContext = createContext<I18nValue>({
  locale: DEFAULT_LANGUAGE,
  t: createTranslate(DEFAULT_LANGUAGE),
});

export function I18nProvider({ children }: { children: ReactNode }): ReactNode {
  const [locale, setLocale] = useState<LanguageCode>(DEFAULT_LANGUAGE);

  useEffect(() => {
    let cancelled = false;
    i18nApi
      .getLocale()
      .then((resolved) => {
        if (!cancelled) setLocale(resolved);
      })
      .catch(() => {
        // 解析失败保留默认语言（不阻塞页面）
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const value = useMemo<I18nValue>(
    () => ({ locale, t: createTranslate(locale) }),
    [locale],
  );

  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}

export function useI18n(): I18nValue {
  return useContext(I18nContext);
}

export function useT(): TranslateFn {
  return useContext(I18nContext).t;
}

export function useLocale(): LanguageCode {
  return useContext(I18nContext).locale;
}

export type { InterpolationParams, LanguageCode, TranslateFn } from './types';
