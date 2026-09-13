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
    historyDesc: string;
    historyConcurrencyDesc: string;
  };
  history: {
    pruned: string;
    remaining: string;
    empty: string;
    failed: string;
  };
  layout: {
    model: string;
    intro: string;
    docs: string;
    docsNone: string;
    docsGenerated: string;
    docsUnit: string;
    docsLegacy: string;
    docsTarget: string;
  };
  config: {
    title: string;
    selectLanguage: string;
    docLanguage: string;
    llmProvider: string;
    thinkingLevel: string;
    maxTurns: string;
    polish: string;
    blueprintDetail: string;
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
  polish: {
    /** 页面标题 */
    title: string;
    /** 当前值 */
    current: string;
    /** 两层机制说明 */
    intro: string;
    /** 开/关与模式标签 */
    enabled: string;
    disabled: string;
    modePromptOnly: string;
    modePromptOnlyDesc: string;
    modeFull: string;
    modeFullDesc: string;
    /** 保护性约束提示 */
    layersHint: string;
    /** Footer */
    footer: string;
  };
  blueprintDetail: {
    /** 页面标题 */
    title: string;
    /** 当前值 */
    current: string;
    /** 档位机制说明 */
    intro: string;
    /** 五档标签与说明 */
    minimal: string;
    minimalDesc: string;
    low: string;
    lowDesc: string;
    medium: string;
    mediumDesc: string;
    high: string;
    highDesc: string;
    max: string;
    maxDesc: string;
    /** Footer */
    footer: string;
  };
  tools: {
    /** 配置首页的条目名与列表页标题 */
    title: string;
    homeLabel: string;
    intro: string;
    ready: string;
    readyRatio: string;
    /** 状态 */
    stateSystem: string;
    stateManaged: string;
    stateMissing: string;
    stateDisabled: string;
    /** 详情页字段 */
    fieldState: string;
    fieldVersion: string;
    fieldPath: string;
    fieldUsedBy: string;
    fieldManagedDir: string;
    fieldEnabled: string;
    notInstalled: string;
    /** 版本未知（探测不到版本号，不影响使用） */
    versionUnknown: string;
    /** 台账版本与探测版本不一致时的提示 */
    versionMismatch: string;
    /** 版本探测输出（诊断用） */
    probeOutput: string;
    probeArgs: string;
    managedHint: string;
    systemHint: string;
    missingHint: string;
    disabledHint: string;
    notInstallable: string;
    enabled: string;
    disabled: string;
    /** 安装相位 */
    phaseResolving: string;
    phaseDownloading: string;
    phaseExtracting: string;
    phaseVerifying: string;
    phaseDone: string;
    /** 动作与结果 */
    installing: string;
    installDone: string;
    installDoneNoVersion: string;
    installFailed: string;
    uninstallDone: string;
    uninstallNothing: string;
    unsavedHint: string;
    /** Footer */
    listFooter: string;
    detailFooter: string;
    busyFooter: string;
    /** 用途说明（按工具 id） */
    usage: {
      rg: string;
      fd: string;
    };
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
    /** 底部合计行：输入 / 输出 token 与缓存占比 */
    usageTotals: string;
    /** 三阶段蓝图：阶段切换与分类级进度 */
    stageClassify: string;
    stageTopics: string;
    stageTitles: string;
    stageTopicsIdle: string;
    stageTitlesIdle: string;
    stageSection: string;
    failedSections: string;
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