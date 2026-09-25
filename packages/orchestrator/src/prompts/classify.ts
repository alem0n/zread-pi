/**
 * 分类命名阶段提示词（结构优先蓝图的第二步）
 *
 * 结构层已把 sections / pages / 文件归属全部由代码构造好；本阶段只做**命名**：
 * 结构分类的 title / description，以及全部分类的 scope。
 * 基础分类（概览 / 核心架构）的 title / description 是系统固定值，提交会被忽略。
 *
 * 提示词-数据契约：机器骨架以 json fence 给出，字段为
 * `machineSections: [{ id, title, description?, slices, fileCount }]`。
 */

import type { BlueprintDetailSpec } from '../agents/blueprint-detail.js';
import type { WikiSection } from '@zread-pi/types';

export interface SectionsNamingPromptOptions {
  spec: BlueprintDetailSpec;
  /** 机器分类清单（结构层产出；json fence 的数据源） */
  machineSections: MachineSectionView[];
  /** sync 命名模式：只允许命名新增 id（提示词按集合展开） */
  onlyIds?: Set<string>;
}

/** 机器分类的提示词视图（结构层的 MachineSection 裁剪到模型需要的字段） */
export interface MachineSectionView {
  id: string;
  title: string;
  description?: string;
  slices: string[];
  fileCount: number;
}

/** 把机器分类清单渲染成 json fence */
export function renderMachineSectionsFence(sections: MachineSectionView[]): string {
  const payload = {
    machineSections: sections.map((section) => ({
      id: section.id,
      title: section.title,
      ...(section.description ? { description: section.description } : {}),
      slices: section.slices,
      fileCount: section.fileCount,
    })),
  };
  return ['```json', JSON.stringify(payload, null, 2), '```'].join('\n');
}

/** sync 只命名新增分类时的清单裁剪 */
function scopeOf(sections: MachineSectionView[], onlyIds?: Set<string>): MachineSectionView[] {
  if (!onlyIds) return sections;
  return sections.filter((section) => onlyIds.has(section.id));
}

export function renderSectionsNamingPrompt(options: SectionsNamingPromptOptions): string {
  const { spec, machineSections, onlyIds } = options;
  const targets = scopeOf(machineSections, onlyIds);

  const lines = [
    '你是一位顶级的软件架构师和领域驱动设计（DDD）专家。这是【结构优先蓝图】的第二步：**只做命名**。',
    '',
    '代码已经把仓库切成互斥的切片并归并成顶级分类（section），文件归属、页面数量、slug 全部由代码确定，**你不规划结构，只给它起名字**。',
    '',
    '## 机器骨架（已落盘，结构不可改）',
    '',
    renderMachineSectionsFence(targets),
    '',
    '- `id` / `slices` / `fileCount` 是机器字段，**逐字保留**，不要出现在你的提交里（提交只收 `title` / `description` / `scope`）；',
    '- 概览（`overview`）与核心架构（`core`）两个基础分类的 title / description 是**系统固定值**，提交会被忽略并回执说明——但它们的 `scope` 你可以补；',
    '- 结构分类的 `title` 是切片代表文件的英文词干，你需要把它翻译成**面向读者的中文标题**。',
    '',
    '## 命名要求',
    '',
    '1. **标题是【产品架构能力视角】**，不是代码包视角：',
    '   - ❌ `util`、`index`、`web-server`、`Router 模块`；',
    '   - ✅ `数据与工具层`、`网络与协议栈`、`CLI 与脚手架`；',
    '2. 标题简洁中文（≤10 字），文档语言为英文时用英文短语；',
    '3. **每个结构分类给一句 `description`**：说明这个分类覆盖什么、面向哪类读者；',
    '4. **每个分类（含基础分类）给出 `scope` 边界清单**：',
    '   - **`包含：` 1~3 条**：本分类覆盖的功能领域（写具体机制 / 层次，不写文件路径）；',
    '   - **`不包含：` 1~3 条**：本分类**明确不覆盖**、最容易混进来的相邻领域，尽量以「（→ 相邻分类标题）」点名；',
    '   - 两个分类的 scope 不得互相包含；宁可多写一条「不包含」，也不要留空。',
    '',
    '## 数量口径',
    '',
    spec.level === 'minimal'
      ? 'minimal 档位固定 1 个分类（概览），无数量空间。'
      : '当前档位 `' +
        spec.level +
        '` 的分类数目标区间是 ' +
        spec.sections.min +
        '~' +
        spec.sections.max +
        '——这是**目标参数**，代码已按它切分完毕，你的提交不会改变分类数量。',
    '',
    '## 示例（仅演示提交结构，切勿照搬名词）',
    '',
    '```json',
    JSON.stringify(
      {
        sections: [
          {
            id: 'sec-S2',
            title: '数据与持久化',
            description: 'ORM、连接池与事务模型',
            scope: [
              '包含：ORM 与查询构建',
              '包含：连接池与事务模型',
              '不包含：网络传输实现（→ 网络与协议栈）',
            ],
          },
          {
            id: 'overview',
            scope: ['包含：项目定位与核心价值', '不包含：具体模块实现（→ 核心架构）'],
          },
        ],
      },
      null,
      2,
    ),
    '```',
    '',
    '## 工具',
    '',
    '调用 `submit_sections` 提交命名清单：',
    '- 入参只认 `id`（必须来自上面的机器清单）+ `title` / `description` / `scope`；',
    '- 未知 id 会被丢弃并在回执里点名；缺失 id 的分类保留机器默认标题；',
    '- 结构（id / slices / 顺序 / 页面）由系统锁定，无法通过本工具改动。',
    '',
    '可以先调用 `get_directory_tree` / `get_core_signatures` / `get_module_details` 核对切片内容再命名（通常 1~3 次工具调用足够），然后一次性提交完整清单。',
  ];

  if (onlyIds && onlyIds.size > 0) {
    lines.push(
      '',
      '## 同步命名范围',
      '',
      '这是对**已生成 Wiki** 的增量同步：只有新增的分类需要命名（' +
        [...onlyIds].join('、') +
        '）。其余分类的标题 / 说明 / 边界已由旧产物冻结，**不要提交它们**（提交会被忽略）。',
    );
  }

  return lines.join('\n');
}

/** 把 wiki.json 的 sections 派生成机器分类视图（供阶段驱动器构造提示词） */
export function machineSectionViews(
  sections: WikiSection[],
  fileCountBySection: Map<string, number>,
): MachineSectionView[] {
  return sections.map((section) => ({
    id: section.id ?? '',
    title: section.title,
    ...(section.description ? { description: section.description } : {}),
    slices: section.slices ?? [],
    fileCount: fileCountBySection.get(section.id ?? '') ?? 0,
  }));
}
