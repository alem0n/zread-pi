/**
 * provider-id - 自定义 Provider 的 id 生成（纯函数）
 *
 * 用户在配置界面只填写「显示名称」，id 由本模块从名称派生：
 * - 小写化 + 非「字母/数字」字符转连字符 + 去掉首尾连字符；
 * - 空名称/纯符号名称回退为 `custom-provider`；
 * - 与已占用 id（内置 Provider + 已配置的自定义 Provider）冲突时追加 `-2` / `-3` …，
 *   保证新建的 Provider 不会覆盖内置 Provider 或既有配置。
 *
 * id 只用作 config.llm.providers 的键与 auth.json 的凭据键，不参与 URL 拼接，
 * 因此非 ASCII（如中文）名称派生的 id 也能正常工作。
 */

/** 空名称回退值 */
export const FALLBACK_PROVIDER_ID = "custom-provider";

/** 把显示名称 slug 化为候选 id（不做去重） */
export function slugifyProviderId(name: string): string {
  const slug = name
    .trim()
    .toLowerCase()
    // Unicode 感知：保留字母与数字，其余字符（空格、标点、分隔符）统一成连字符
    .replace(/[^\p{L}\p{N}]+/gu, "-")
    .replace(/^-+|-+$/g, "");
  return slug || FALLBACK_PROVIDER_ID;
}

/**
 * 生成唯一 provider id：与 `taken`（内置 + 已配置的 id 集合）冲突时追加序号。
 *
 * `taken` 由调用方传入（ConfigStore 的 providers 键 + pi-ai 内置目录），
 * 保持本函数纯度便于直接断言。
 */
export function uniqueProviderId(name: string, taken: ReadonlySet<string>): string {
  const base = slugifyProviderId(name);
  if (!taken.has(base)) return base;
  for (let index = 2; index < 1000; index++) {
    const candidate = `${base}-${index}`;
    if (!taken.has(candidate)) return candidate;
  }
  // 上限只是防御性兜底，实际不可能触达
  return `${base}-${Date.now()}`;
}
