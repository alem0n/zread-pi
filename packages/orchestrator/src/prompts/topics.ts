/**
 * 页面命名阶段提示词（结构优先蓝图的第三步）
 *
 * 每个分类一个 Agent；提示词含该分类的机器页面清单（json fence），
 * 模型只填 title / summary / group / level；slug / 文件归属由系统固定。
 *
 * 提示词-数据契约：`machinePages: [{ id, label, files, refs, seams }]`。
 */

import type { BlueprintDetailSpec } from '../agents/blueprint-detail.js';
import type { WikiPage } from '@zread-pi/types';

export interface PagesNamingPromptOptions {
  spec: BlueprintDetailSpec;
  /** 分类标题（工具入参的 section 必须与之一致） */
  section: string;
  /** 该分类的机器页面清单（json fence 的数据源） */
  machinePages: MachinePageView[];
  /** sync 命名模式：只允许命名新增页面 id */
  onlyIds?: Set<string>;
}

/** 机器页面的提示词视图 */
export interface MachinePageView {
  id: string;
  /** 机器默认标题（切片标签） */
  label: string;
  /** 该页拥有的文件（机器字段，不可改） */
  files: string[];
  /** 跨页引用（path + reason + ownerSlug） */
  refs?: Array<{ path: string; reason: string; ownerSlug: string }>;
  /** 触及本页的缝合线数（信息性） */
  seams: number;
}

/** 把机器页面清单渲染成 json fence */
export function renderMachinePagesFence(pages: MachinePageView[]): string {
  const payload = {
    machinePages: pages.map((page) => ({
      id: page.id,
      label: page.label,
      files: page.files,
      ...(page.refs && page.refs.length > 0 ? { refs: page.refs } : {}),
      seams: page.seams,
    })),
  };
  return ['```json', JSON.stringify(payload, null, 2), '```'].join('\n');
}

function scopeOf(pages: MachinePageView[], onlyIds?: Set<string>): MachinePageView[] {
  if (!onlyIds) return pages;
  return pages.filter((page) => onlyIds.has(page.id));
}

export function renderPagesNamingPrompt(options: PagesNamingPromptOptions): string {
  const { spec, section, machinePages, onlyIds } = options;
  const targets = scopeOf(machinePages, onlyIds);

  const lines = [
    '你是一位顶级的软件架构师。这是【结构优先蓝图】的第三步：为**当前这一个分类**的页面命名。',
    '',
    '代码已经把该分类下的页面（每页拥有哪些源文件）、slug、跨页引用全部确定好，**你不规划页面结构，只给页面起名字**。',
    '',
    '## 当前分类',
    '',
    '- 分类：' + section,
    '',
    '## 机器页面清单（已落盘，结构不可改）',
    '',
    renderMachinePagesFence(targets),
    '',
    '- `id` / `files` / `refs` 是机器字段，**逐字保留**；提交只收 `title` / `summary` / `group` / `level`；',
    '- `files` 是这一页**独占**的源文件（代码级排他，别的页不会重复拥有）；`refs` 是这一页引用了别页文件的真实依赖边；',
    '- 缺失的 id 保留机器默认标题（切片 label），不要编造不在清单里的 id（提交会被丢弃并回执点名）。',
    '',
    '## 命名要求',
    '',
    '1. **标题是【产品架构能力视角】**，不是代码包视角：',
    '   - ❌ `util.ts 模块`、`handler 文件`、`types 定义`；',
    '   - ✅ `连接池：复用、超时与背压`、`路由树：动态解析与冲突消解`；',
    '2. 标题简洁（≤20 字），文档语言为英文时用英文短语；同分类内标题不重复；',
    '3. **每页给一句 `summary`（≤40 字）**：说明这一页论证什么、以哪些文件为证据（它会被逐字注入页面写作提示词，作为范围锚点）；',
    '4. `group` 可选：把同分类内强相关的几页捏在一起（侧边栏二级聚合）；',
    '5. `level`：`Beginner` / `Intermediate` / `Advanced`。',
    '',
    '## 数量口径',
    '',
    spec.level === 'minimal'
      ? 'minimal 档位每个分类固定 1 页，无数量空间。'
      : '当前档位 `' +
        spec.level +
        '` 的每分类页数目标区间是 ' +
        spec.topics.min +
        '~' +
        spec.topics.max +
        '——这是**目标参数**，代码已按它切分完毕，你的提交不会改变页面数量。',
    '',
    '## 工具',
    '',
    '调用 `submit_pages` 提交本分类的命名清单：',
    '- 入参 `section` 必须与上方「当前分类」一致；',
    '- 每个 `pages` 条目用 `id`（来自机器清单）携带 `title` / `summary` / `group` / `level`；',
    '- 同分类内 title 重复的提交会被跳过；未知 id 被丢弃并回执点名。',
    '',
    '可以先调用 `get_module_details` / `get_core_signatures` 核对 `files` 里的符号再命名（通常 1~3 次工具调用足够），然后一次性提交完整清单。',
  ];

  if (onlyIds && onlyIds.size > 0) {
    lines.push(
      '',
      SYNC_NAMING_RULES,
      '',
      '待命名的页面 id：' + [...onlyIds].join('、') + '。',
    );
  }

  return lines.join('\n');
}

/** sync 只命名新增页面时的追加规则（静态部分；id 清单由调用方展开） */
export const SYNC_NAMING_RULES = [
  '',
  '## 同步命名范围（极其重要）',
  '',
  '这是对**已生成 Wiki** 的增量同步，不是全量重新规划：',
  '',
  '1. **只命名待命名清单里的 id**：这些是代码新切出来的页面，还没有标题；',
  '2. **旧页面勿提交**：它们的 slug / file / title / summary 已物理冻结，提交旧 id 会被丢弃；',
  '3. **不要试图删除或重排页面**：页面结构与文件归属由代码机械对齐，不归命名阶段管。',
].join('\n');

/**
 * 把机器页条目派生成提示词视图（条目来自 buildMachineBlueprint 的 pages，
 * 携带运行期 id；wiki.json 不存 id，必须由阶段驱动器从条目列表构造）。
 */
export function machinePageViews(entries: Array<{ id: string; page: WikiPage }>): MachinePageView[] {
  return entries.map((entry) => ({
    id: entry.id,
    label: entry.page.title,
    files: entry.page.ownsFiles ?? [],
    ...(entry.page.refs && entry.page.refs.length > 0 ? { refs: entry.page.refs } : {}),
    seams: entry.page.refs?.length ?? 0,
  }));
}
