/**
 * i18n 类型定义
 */

/** 支持的语言代码 */
export type LanguageCode = 'zh-CN' | 'en-US';

/** 翻译字典结构 */
export interface TranslationKeys {
  cli: {
    version: string;
    help: string;
    dirDesc: string;
    dirInvalid: string;
    wikiDesc: string;
    configDesc: string;
    browseDesc: string;
  };
  layout: {
    provider: string;
    model: string;
    baseUrl: string;
    thinking: string;
    directory: string;
    intro: string;
  };
  config: {
    title: string;
    selectLanguage: string;
    docLanguage: string;
    llmProvider: string;
    thinkingLevel: string;
    maxTurns: string;
    maxConcurrency: string;
    maxRetries: string;
    default: string;
    notConfigured: string;
    footer: string;
    saved: string;
    saveFailed: string;
    hasUnsavedChanges: string;
    pressS: string;
    current: string;
    range: string;
    invalidRange: string;
  };
  language: {
    select: string;
    zh: string;
    en: string;
    current: string;
    footer: string;
  };
  docLanguage: {
    select: string;
    zh: string;
    en: string;
    current: string;
    footer: string;
  };
  provider: {
    select: string;
    search: string;
    custom: string;
    refresh: string;
    loading: string;
    current: string;
    footer: string;
    error: string;
    configured: string;
    notConfigured: string;
    models: string;
    authApiKey: string;
    authOauth: string;
    source: string;
    customBadge: string;
  };
  model: {
    select: string;
    custom: string;
    loading: string;
    tokens: string;
    supports: string;
    footer: string;
    noModels: string;
    customInput: string;
    count: string;
    customBadge: string;
    reasoning: string;
    vision: string;
    refreshing: string;
    refreshDone: string;
    refreshUnsupported: string;
    refreshFailed: string;
  };
  apikey: {
    input: string;
    placeholder: string;
    hidden: string;
    required: string;
    footer: string;
    saved: string;
    saving: string;
  };
  detail: {
    apiKeyTitle: string;
    modelsTitle: string;
    keyPlaceholderConfigured: string;
    keySaved: string;
    keyFailed: string;
    keyFirst: string;
    oauthOnly: string;
    ambient: string;
    currentSet: string;
    footer: string;
    keyFooter: string;
  };
  auth: {
    loggingIn: string;
  };
  customModel: {
    title: string;
    id: string;
    idPlaceholder: string;
    name: string;
    namePlaceholder: string;
    contextWindow: string;
    contextPlaceholder: string;
    maxTokens: string;
    maxTokensPlaceholder: string;
    reasoning: string;
    vision: string;
    toggleHint: string;
    api: string;
    idRequired: string;
    invalidNumber: string;
    footer: string;
    saved: string;
  };
  customProvider: {
    title: string;
    baseUrl: string;
    baseUrlPlaceholder: string;
    modelName: string;
    modelNamePlaceholder: string;
    apikey: string;
    invalidUrl: string;
    footer: string;
    step: string;
  };
  concurrency: {
    set: string;
    range: string;
    invalid: string;
    current: string;
    footer: string;
  };
  retry: {
    set: string;
    range: string;
    invalid: string;
    current: string;
    footer: string;
  };
  thinking: {
    title: string;
    current: string;
    modelUnset: string;
    supported: string;
    unsupportedLevel: string;
    footer: string;
    levels: {
      off: string;
      minimal: string;
      low: string;
      medium: string;
      high: string;
      xhigh: string;
      max: string;
    };
  };
  maxTurns: {
    set: string;
    range: string;
    hint: string;
    invalid: string;
    current: string;
    footer: string;
  };
  common: {
    escBack: string;
    saveAndBack: string;
  };
  divider: {
    prefix: string;
    middle: string;
  };
  wiki: {
    title: string;
    generate: string;
    continue: string;
    manage: string;
    browse: string;
    force: string;
    firstTimeConfig: string;
    config: string;
    exit: string;
    footer: string;
    // Divider status titles
    dividerFirstTime: string;
    dividerNoCatalog: string;
    dividerHasCatalog: string;
    dividerInProgress: string;
    dividerComplete: string;
    // Sync
    sync: string;
    dividerHasSync: string;
  };
  wikiGenerate: {
    catalogTitle: string;
    articlesTitle: string;
    waiting: string;
    requesting: string;
    responding: string;
    tool: string;
    retrying: string;
    completed: string;
    failed: string;
    navigate: string;
    retry: string;
    exit: string;
  };
  browse: {
    title: string;
    starting: string;
    running: string;
    url: string;
    footer: string;
    stopped: string;
    startFailed: string;
    noDocs: string;
  };
}

/** 插值参数类型 */
export interface InterpolationParams {
  [key: string]: string | number;
}

/** 翻译函数类型 */
export type TranslateFn = (key: string, params?: InterpolationParams) => string;