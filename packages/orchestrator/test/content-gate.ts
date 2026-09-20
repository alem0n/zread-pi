/**
 * content-gate.ts —— 内容密度门（quality.contentGate）验证
 *
 * 移植自 lecture-to-notes 的 verify_notes.py::density_gate（先复制后兼容）。
 *
 * A) 纯函数指标：剥离 frontmatter / 代码块 / Mermaid / Sources 行 / 表格后的散文计数、
 *    标题层级与跳级、Mermaid / 代码块计数、句首重复。
 * B) 下限表：proseFloor 随 level × 关联文件数自适应（封顶）；mermaidRequiredFor 由
 *    section 角色 / minimal panorama 派生（不挂 level 表）；codeRecommendedFor。
 * C) 评估：warn / enforce 报告标记、失败文案带「当前 N / 下限 M」。
 * D) write_page 拦截（无 LLM）：off 无报告、warn 不拦截落盘、enforce 拦截 + 常驻反馈。
 * E) 反注水（§4）：源没有可写代码时代码块为 0 不判失败；Mermaid 非概览页 0 合法。
 * F) 配置归一化：normalizeQualityConfig 缺省/非法值回退；resolveGateMode 开关语义。
 *
 * 运行：bun run packages/orchestrator/test/content-gate.ts
 */

import { mkdtemp, mkdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  evaluateContentGate,
  extractGateMetrics,
  extractGateReport,
  formatContentGateError,
  proseFloor,
  mermaidRequiredFor,
  codeRecommendedFor,
  resolveGateMode,
} from '../src/wiki/content-gate.js';
import { createWritePageTool } from '../src/tools/page-tools.js';
import { getDetailSpec } from '../src/agents/blueprint-detail.js';
import {
  normalizeQualityConfig,
  DEFAULT_QUALITY_ENABLED,
  DEFAULT_QUALITY_MODE,
  DEFAULT_VERIFY_AFTER_GENERATE,
} from '@zread-pi/utils';
import type { WikiPage } from '@zread-pi/types';

const checks: Array<{ name: string; ok: boolean; detail?: string }> = [];
function check(name: string, ok: boolean, detail?: string): void {
  checks.push({ name, ok, detail });
  console.log(`${ok ? '  ✅' : '  ❌'} ${name}${detail ? ` — ${detail}` : ''}`);
}

// ---------------------------------------------------------------------------
// 临时目录（write_page 落盘用）
// ---------------------------------------------------------------------------
const sandbox = await mkdtemp(join(tmpdir(), 'zread-pi-gate-'));
await mkdir(join(sandbox, '概览'), { recursive: true });

function makePage(overrides: Partial<WikiPage> = {}): WikiPage {
  return {
    slug: 'p1',
    title: '测试页',
    file: 'p1.md',
    section: '概览',
    level: 'Intermediate',
    associatedFiles: ['src/a.ts', 'src/b.ts'],
    ...overrides,
  };
}

/** 生成一段指定字符数的中文散文（不含代码 / 表格 / Sources） */
function prose(chars: number): string {
  const unit = '内容密度门把干瘪的页面变成可判定的指标。';
  const times = Math.ceil(chars / unit.length);
  return unit.repeat(times).slice(0, chars);
}

/** 拼一篇带 frontmatter 的完整页面 */
function fullPage(body: string, title = '测试页', slug = 'p1'): string {
  return [`---`, `title: "${title}"`, `slug: "${slug}"`, `---`, '', body].join('\n');
}

// ===========================================================================
// A) 指标提取（黄金值）
// ===========================================================================
console.log('\nA) 指标提取');

{
  const content = fullPage([
    '## 架构总览',
    '',
    prose(2000),
    '',
    'Sources: [a.ts](src/a.ts#L1-L20)',
    '',
    '```mermaid',
    'flowchart TB',
    '  A["核心"]',
    '```',
    '',
    '```ts',
    'const x = 1;',
    '```',
    '',
    '| 名称 | 值 |',
    '|------|----|',
    '| A | 1 |',
    '',
    '### 细节',
    '',
    prose(500),
    '',
    'Sources: [b.ts](src/b.ts#L5-L10)',
  ].join('\n'));

  const m = extractGateMetrics(content);
  // 散文 = 两段中文 + 标题文字；代码块 / Mermaid / Sources / 表格 / frontmatter 全部剥离
  check('散文计数剥离代码块/Mermaid/Sources/表格/frontmatter', m.proseChars > 2500, `proseChars=${m.proseChars}`);
  check('代码块计数=1（不含 Mermaid）', m.codeBlocks === 1, `codeBlocks=${m.codeBlocks}`);
  check('Mermaid 块计数=1', m.mermaidBlocks === 1, `mermaidBlocks=${m.mermaidBlocks}`);
  check('Sources 行计数=2', m.sourceNotes === 2, `sourceNotes=${m.sourceNotes}`);
  check('标题计数=2（## 与 ###）', m.headings === 2, `headings=${m.headings}`);
  check('标题层级序列=[2,3]', JSON.stringify(m.headingLevels) === JSON.stringify([2, 3]));
  check('句首重复=0', m.repeatOpenings === 0, `repeatOpenings=${m.repeatOpenings}`);
}

{
  // 无 frontmatter 的裸内容也能正常计数
  const m = extractGateMetrics(prose(300));
  check('无 frontmatter 时散文仍计数', m.proseChars >= 300, `proseChars=${m.proseChars}`);
  check('无标题时 headings=0', m.headings === 0);
}

// 标题跳级检测
{
  const m = extractGateMetrics('# H1\n\n散文\n\n### H3\n');
  check('标题跳级（# → ###）被记录', JSON.stringify(m.headingLevels) === JSON.stringify([1, 3]));
}
{
  const m = extractGateMetrics('## H2\n\n散文\n\n### H3\n');
  check('正常层级（## → ###）不跳级', JSON.stringify(m.headingLevels) === JSON.stringify([2, 3]));
}

// 句首重复检测
{
  const paragraphs = ['首先我们看 A。', '其次我们看 B。', '然后我们看 C。'].join('\n\n');
  const m = extractGateMetrics(paragraphs);
  check('不同句首不重复', m.repeatOpenings === 0, `repeatOpenings=${m.repeatOpenings}`);
}
{
  // 连续 3 段同前缀词（「重复开」）
  const paragraphs = ['重复开头段落一。', '重复开头段落二。', '重复开头段落三。'].join('\n\n');
  const m = extractGateMetrics(paragraphs);
  check('连续 3 段同前缀词 → repeatOpenings=3', m.repeatOpenings === 3, `repeatOpenings=${m.repeatOpenings}`);
}
{
  // 连续 2 段同前缀词（不足 3，不算）
  const paragraphs = ['重复开头段落一。', '重复开头段落二。'].join('\n\n');
  const m = extractGateMetrics(paragraphs);
  check('连续 2 段同前缀词不算（<3）', m.repeatOpenings === 0, `repeatOpenings=${m.repeatOpenings}`);
}

// ===========================================================================
// B) 下限表
// ===========================================================================
console.log('\nB) 下限表（自适应 level × 关联文件数）');

{
  const beginner = makePage({ level: 'Beginner', associatedFiles: ['a.ts'] });
  const inter = makePage({ level: 'Intermediate', associatedFiles: ['a.ts', 'b.ts'] });
  const adv = makePage({ level: 'Advanced', associatedFiles: ['a.ts'] });
  check('Beginner 下限=1200+200', proseFloor(beginner) === 1400, `${proseFloor(beginner)}`);
  check('Intermediate 2 文件下限=1800+400', proseFloor(inter) === 2200, `${proseFloor(inter)}`);
  check('Advanced 下限=2400+200', proseFloor(adv) === 2600, `${proseFloor(adv)}`);
  check('难度越高下限越高', proseFloor(adv) > proseFloor(inter));
}

{
  // 目录（以 / 结尾）不计入源文件数
  const withDir = makePage({ level: 'Intermediate', associatedFiles: ['src/', 'a.ts', 'b.ts', 'c.ts'] });
  check('目录不计入源文件数', proseFloor(withDir) === 1800 + 200 * 3, `${proseFloor(withDir)}`);
}

{
  // 文件数超过 cap（8）后下限封顶
  const many = makePage({
    level: 'Intermediate',
    associatedFiles: Array.from({ length: 20 }, (_, i) => `f${i}.ts`),
  });
  check('关联文件超过 8 个后下限按 8 个计', proseFloor(many) === 1800 + 200 * 8, `${proseFloor(many)}`);
  check('下限有绝对封顶（3400）', proseFloor(many) === 3400);
}

{
  // mermaidRequiredFor：由 section 角色与 panorama 派生，不看 level
  const highSpec = getDetailSpec('high');
  const overview = makePage({ section: '概览', level: 'Beginner' });
  const overviewEn = makePage({ section: 'Overview', level: 'Advanced' });
  const core = makePage({ section: '核心架构' });
  const other = makePage({ section: '工具函数' });
  check('概览页强制 Mermaid（中文）', mermaidRequiredFor(overview, highSpec) === true);
  check('Overview 页强制 Mermaid（英文，大小写不敏感）', mermaidRequiredFor(overviewEn, highSpec) === true);
  check('核心架构页强制 Mermaid', mermaidRequiredFor(core, highSpec) === true);
  // 「快速开始」基础分类已移除：该角色不再强制 Mermaid（回归断言，防回潮）
  check('快速开始页不再强制 Mermaid（基础分类已移除）', mermaidRequiredFor(makePage({ section: '快速开始' }), highSpec) === false);
  check('Quick Start 页不再强制 Mermaid（英文角色同步移除）', mermaidRequiredFor(makePage({ section: 'Quick Start' }), highSpec) === false);
  check('普通页不强制 Mermaid', mermaidRequiredFor(other, highSpec) === false);
  check('minimal 档 panorama 强制 Mermaid（无论 section）', mermaidRequiredFor(other, getDetailSpec('minimal')) === true);
  // 正交性：Beginner 概览页与 Advanced 概览页的 Mermaid 判定相同
  check('level 不影响 Mermaid 判定（正交）', mermaidRequiredFor(overview, highSpec) === mermaidRequiredFor(overviewEn, highSpec));
}

{
  // codeRecommendedFor：Beginner 不建议，Intermediate/Advanced 关联源文件时建议
  check('Beginner 不建议代码块', codeRecommendedFor(makePage({ level: 'Beginner' })) === false);
  check('Intermediate 关联源文件建议代码块', codeRecommendedFor(makePage({ level: 'Intermediate' })) === true);
  check('Advanced 关联源文件建议代码块', codeRecommendedFor(makePage({ level: 'Advanced' })) === true);
  check('只关联目录时不建议代码块', codeRecommendedFor(makePage({ associatedFiles: ['src/'] })) === false);
}

// ===========================================================================
// C) 评估与反馈文案
// ===========================================================================
console.log('\nC) 评估 / 反馈');

{
  const page = makePage({ level: 'Intermediate', section: '工具函数' });
  const good = fullPage(['## 结构', '', prose(2500), '', 'Sources: [a.ts](src/a.ts#L1-L9)'].join('\n'));
  const report = evaluateContentGate(good, page, getDetailSpec('high'), 'warn');
  check('达标页面 passed=true', report.passed === true, JSON.stringify(report.failures));
  check('warn 模式报告 mode=warn', report.mode === 'warn');
  check('达标页面 failures 为空', report.failures.length === 0);
  // 关联了源文件但没有代码块 → 软性建议（不影响 passed）
  check('无代码块走 advisories 而非 failures', report.advisories.some((a) => a.includes('代码片段')));
}

{
  const page = makePage({ level: 'Intermediate', section: '工具函数' });
  const thin = fullPage(['## 结构', '', '太短了。', '', 'Sources: [a.ts](src/a.ts)'].join('\n'));
  const report = evaluateContentGate(thin, page, getDetailSpec('high'), 'enforce');
  check('干瘪页面 passed=false', report.passed === false);
  check('enforce 模式报告 mode=enforce', report.mode === 'enforce');
  const text = formatContentGateError(report);
  check('失败文案带「当前 N / 下限 M」', text.includes('当前') && text.includes('下限'));
  check('失败文案含反注水提示', text.includes('门限是下限不是目标'));
}

{
  // 缺少 H2
  const page = makePage({ section: '工具函数' });
  const noH2 = fullPage([prose(2500), '', 'Sources: [a.ts](src/a.ts)'].join('\n'));
  const report = evaluateContentGate(noH2, page, getDetailSpec('high'));
  check('缺少二级标题判失败', report.failures.some((f) => f.includes('二级标题')));
}

{
  // 缺少 Sources
  const page = makePage({ section: '工具函数' });
  const noSrc = fullPage(['## 结构', '', prose(2500)].join('\n'));
  const report = evaluateContentGate(noSrc, page, getDetailSpec('high'));
  check('缺少 Sources 判失败', report.failures.some((f) => f.includes('Sources')));
}

{
  // 概览页缺 Mermaid
  const page = makePage({ section: '概览' });
  const noMermaid = fullPage(['## 结构', '', prose(2500), '', 'Sources: [a.ts](src/a.ts)'].join('\n'));
  const report = evaluateContentGate(noMermaid, page, getDetailSpec('high'));
  check('概览页缺 Mermaid 判失败', report.failures.some((f) => f.includes('Mermaid')));
}

{
  // 普通页 Mermaid=0 合法（反注水：源没有图就不该硬凑）
  const page = makePage({ section: '工具函数' });
  const ok = fullPage(['## 结构', '', prose(2500), '', 'Sources: [a.ts](src/a.ts)'].join('\n'));
  const report = evaluateContentGate(ok, page, getDetailSpec('high'));
  check('普通页无 Mermaid 不判失败', !report.failures.some((f) => f.includes('Mermaid')));
}

{
  // 标题跳级判失败
  const page = makePage({ section: '工具函数' });
  const skip = fullPage(['# H1', '', prose(2500), '', '### H3', '', 'Sources: [a.ts](src/a.ts)'].join('\n'));
  const report = evaluateContentGate(skip, page, getDetailSpec('high'));
  check('标题跳级判失败', report.failures.some((f) => f.includes('跳级')));
}

{
  // 句首重复判失败（每段之间空行分隔，才是三个独立段落）
  const page = makePage({ section: '工具函数' });
  const repeat = fullPage([
    '## 结构',
    '',
    '重复开头第一段很长很长很长很长很长很长很长。',
    '',
    '重复开头第二段很长很长很长很长很长很长很长。',
    '',
    '重复开头第三段很长很长很长很长很长很长很长。',
    '',
    'Sources: [a.ts](src/a.ts)',
  ].join('\n'));
  const report = evaluateContentGate(repeat, page, getDetailSpec('high'));
  check('句首重复判失败', report.failures.some((f) => f.includes('句首重复')));
}

// ===========================================================================
// E) 反注水：源没有可写代码时代码块为 0 不判失败
// ===========================================================================
console.log('\nE) 反注水');

{
  const page = makePage({ level: 'Intermediate', section: '工具函数', associatedFiles: ['src/'] });
  const noCode = fullPage(['## 结构', '', prose(2500), '', 'Sources: [a.ts](src/a.ts)'].join('\n'));
  const report = evaluateContentGate(noCode, page, getDetailSpec('high'));
  check('只关联目录（无源文件）时无代码块不判失败', !report.failures.some((f) => f.includes('代码片段')));
}

{
  // Beginner 页面无代码块也不判失败（codeRecommended=false）
  const page = makePage({ level: 'Beginner', section: '工具函数', associatedFiles: ['a.ts'] });
  const noCode = fullPage(['## 结构', '', prose(1500), '', 'Sources: [a.ts](src/a.ts)'].join('\n'));
  const report = evaluateContentGate(noCode, page, getDetailSpec('high'));
  check('Beginner 页面无代码块不判失败', !report.failures.some((f) => f.includes('代码片段')));
}

// ===========================================================================
// D) write_page 拦截（无 LLM，直接调工具）
// ===========================================================================
console.log('\nD) write_page 拦截');

const spec = getDetailSpec('high');

{
  // off（不传 contentGate）：行为与迁移前一致，结果不带 gate 字段
  const tool = createWritePageTool({ variant: 'high' });
  const cwd = await mkdtemp(join(tmpdir(), 'zread-gate-off-'));
  const result = await tool.call(
    { slug: 'p1', content: '## A\n\n短内容。\n\nSources: [a](a.ts)' },
    { cwd },
  );
  check('off 模式成功落盘', !result.is_error);
  check('off 模式结果无 gate 字段', extractGateReport(result.content) === undefined);
  await rm(cwd, { recursive: true, force: true });
}

{
  // warn：干瘪页面也落盘，只是报告 passed=false
  const tool = createWritePageTool({
    variant: 'high',
    contentGate: { mode: 'warn', page: makePage({ section: '工具函数' }), spec },
  });
  const cwd = await mkdtemp(join(tmpdir(), 'zread-gate-warn-'));
  const result = await tool.call(
    { slug: 'p1', file: 'p1.md', section: '工具函数', title: '测试', content: '太短了。\n\nSources: [a](a.ts)' },
    { cwd },
  );
  check('warn 模式不拦截（成功落盘）', !result.is_error);
  const report = extractGateReport(result.content);
  check('warn 模式结果携带 gate 报告', report !== undefined);
  check('warn 报告 passed=false（干瘪）', report !== undefined && report.passed === false);
  check('warn 报告 mode=warn', report !== undefined && report.mode === 'warn');
  const written = await readFile(join(cwd, '.zread-pi', 'wiki', 'high', '工具函数', 'p1.md'), 'utf-8');
  check('warn 模式文件确实写入', written.includes('太短了'));
  await rm(cwd, { recursive: true, force: true });
}

{
  // enforce：干瘪页面被拦截（is_error），文件不落盘，文案带常驻反馈
  const tool = createWritePageTool({
    variant: 'high',
    contentGate: { mode: 'enforce', page: makePage({ section: '工具函数' }), spec },
  });
  const cwd = await mkdtemp(join(tmpdir(), 'zread-gate-enforce-'));
  const result = await tool.call(
    { slug: 'p1', file: 'p1.md', section: '工具函数', title: '测试', content: '太短了。\n\nSources: [a](a.ts)' },
    { cwd },
  );
  check('enforce 模式拦截干瘪页面', result.is_error === true);
  const report = extractGateReport(result.content);
  check('enforce 拦截结果携带 gate 报告', report !== undefined && report.passed === false);
  let notWritten = false;
  try {
    await readFile(join(cwd, '.zread-pi', 'wiki', 'high', '工具函数', 'p1.md'), 'utf-8');
  } catch {
    notWritten = true;
  }
  check('enforce 拦截时文件不落盘', notWritten);
  const text = typeof result.content === 'string' ? result.content : '';
  check('enforce 错误文案带「当前 / 下限」', text.includes('当前') && text.includes('下限'));
  await rm(cwd, { recursive: true, force: true });
}

{
  // enforce：达标页面正常落盘
  const tool = createWritePageTool({
    variant: 'high',
    contentGate: { mode: 'enforce', page: makePage({ section: '工具函数' }), spec },
  });
  const cwd = await mkdtemp(join(tmpdir(), 'zread-gate-ok-'));
  const result = await tool.call(
    {
      slug: 'p1',
      file: 'p1.md',
      section: '工具函数',
      title: '测试',
      content: `## 结构\n\n${prose(2500)}\n\nSources: [a.ts](src/a.ts#L1-L9)`,
    },
    { cwd },
  );
  check('enforce 模式达标页面成功落盘', !result.is_error);
  const report = extractGateReport(result.content);
  check('enforce 达标报告 passed=true', report !== undefined && report.passed === true);
  await rm(cwd, { recursive: true, force: true });
}

// ===========================================================================
// F) 配置归一化与模式解析
// ===========================================================================
console.log('\nF) 配置归一化');

{
  const empty = normalizeQualityConfig(undefined);
  check('缺省 enabled=true', empty.contentGate.enabled === DEFAULT_QUALITY_ENABLED);
  check('缺省 mode=warn', empty.contentGate.mode === DEFAULT_QUALITY_MODE);
  check('缺省 verifyAfterGenerate=false', empty.verifyAfterGenerate === DEFAULT_VERIFY_AFTER_GENERATE);
}

{
  const illegal = normalizeQualityConfig({ contentGate: { enabled: 'yes', mode: 'strict' }, verifyAfterGenerate: 1 });
  check('非法 enabled 回退 true', illegal.contentGate.enabled === true);
  check('非法 mode 回退 warn', illegal.contentGate.mode === 'warn');
  check('非法 verifyAfterGenerate 回退 false', illegal.verifyAfterGenerate === false);
}

{
  const custom = normalizeQualityConfig({ contentGate: { enabled: false, mode: 'enforce' }, verifyAfterGenerate: true });
  check('合法值保留（enabled=false）', custom.contentGate.enabled === false);
  check('合法值保留（mode=enforce）', custom.contentGate.mode === 'enforce');
  check('合法值保留（verifyAfterGenerate=true）', custom.verifyAfterGenerate === true);
}

{
  check('resolveGateMode: 未配置 → off', resolveGateMode({}) === 'off');
  check('resolveGateMode: enabled=false → off', resolveGateMode({ quality: { contentGate: { enabled: false, mode: 'enforce' } } }) === 'off');
  check('resolveGateMode: enabled=true + warn → warn', resolveGateMode({ quality: { contentGate: { enabled: true, mode: 'warn' } } }) === 'warn');
  check('resolveGateMode: enabled=true + enforce → enforce', resolveGateMode({ quality: { contentGate: { enabled: true, mode: 'enforce' } } }) === 'enforce');
  check('resolveGateMode: mode=off → off', resolveGateMode({ quality: { contentGate: { enabled: true, mode: 'off' } } }) === 'off');
}

await rm(sandbox, { recursive: true, force: true });

// ---------------------------------------------------------------------------
// 汇总
// ---------------------------------------------------------------------------
const failed = checks.filter((c) => !c.ok);
console.log(`\n${'-'.repeat(60)}`);
console.log(`内容密度门：${checks.length - failed.length}/${checks.length} 通过`);
if (failed.length > 0) {
  for (const c of failed) console.log(`  ❌ ${c.name}${c.detail ? ` — ${c.detail}` : ''}`);
  process.exitCode = 1;
}
