/**
 * Output Tools - 结构优先蓝图的命名工具
 *
 * - `submit_sections`：分类命名阶段，只写 title（结构分类）/ description（结构分类）/ scope（全部）；
 * - `submit_pages`：页面命名阶段，只写 title / topicSummary / group / level。
 *
 * 结构（id / slices / 顺序 / slug / file / section / ownsFiles / associatedFiles / refs）
 * 由代码在机器蓝图阶段构造并锁定，命名工具**结构上不可能**改动它们。
 *
 * 落盘走 utils 的 `applySectionNames` / `applyPageNames`（文件锁 + 原子替换）。
 */

import type {
  ToolDefinition,
  ToolInputParams,
  ToolInputSchemaProperty,
  ToolContext,
  ToolResult,
} from '@zread-pi/agent-runtime';
import {
  applyPageNames,
  applySectionNames,
  type ApplyPageNamesResult,
  type ApplySectionNamesResult,
  type MachinePageEntry,
} from '@zread-pi/utils';
import type { BlueprintDetailLevel } from '@zread-pi/types';

/** 统一的 tool_result 构造 */
function okResult(content: string): ToolResult {
  return { type: 'tool_result', tool_use_id: '', content };
}

function failResult(content: string): ToolResult {
  return { type: 'tool_result', tool_use_id: '', content, is_error: true };
}

/** 命名条目 schema（submit_sections / submit_pages 共用形状） */
const SECTION_NAME_SCHEMA: ToolInputSchemaProperty = {
  type: 'object',
  properties: {
    id: { type: 'string', description: '机器分类 id（必须来自提示词给出的机器清单）' },
    title: { type: 'string', description: '分类标题（简洁中文，≤10 字；基础分类的提交会被忽略）' },
    description: { type: 'string', description: '分类说明（这个分类覆盖什么、面向哪类读者；基础分类的提交会被忽略）' },
    scope: {
      type: 'array',
      items: { type: 'string' },
      description:
        '分类的边界清单：1~3 条「包含：本分类覆盖的功能领域」+ 1~3 条「不包含：明确不覆盖的相邻领域（→ 其他分类）」',
    },
  },
  required: ['id'],
};

const PAGE_NAME_SCHEMA: ToolInputSchemaProperty = {
  type: 'object',
  properties: {
    id: { type: 'string', description: '机器页面 id（必须来自提示词给出的机器页面清单）' },
    title: { type: 'string', description: '页面标题（≤20 字，同分类内不重复）' },
    summary: {
      type: 'string',
      description: '一句话主题摘要（≤40 字，说明这篇论证什么、以哪些文件为证据）',
    },
    group: { type: 'string', description: '二级模块聚合（可选）' },
    level: { type: 'string', description: '难度等级（Beginner/Intermediate/Advanced）' },
  },
  required: ['id'],
};

/**
 * Submit Sections Tool（分类命名阶段）
 *
 * 只接受 `id` + 语义字段；id / slices / 顺序由机器骨架锁定。
 * `machineIds` 是允许写入的 id 集合（sync 增量命名时收窄为新增集合）。
 */
export function createSubmitSectionsTool(options: {
  variant?: BlueprintDetailLevel;
  /** 允许命名的机器分类 id（缺省 = 全部；sync 只允许新增 id） */
  onlyIds?: Set<string>;
  /** 写回结果回调（阶段驱动器用它判断「是否成功调用」） */
  onResult?: (result: ApplySectionNamesResult) => void;
} = {}): ToolDefinition {
  const variant = options.variant ?? 'high';

  return {
    name: 'submit_sections',
    description: '提交 Wiki 顶级分类（section）的命名清单（只写 title / description / scope，结构由代码锁定）。',
    inputSchema: {
      type: 'object',
      properties: {
        sections: {
          type: 'array',
          description: '分类命名清单（id 必须来自机器骨架；未知 id 会被丢弃并回执点名）',
          items: SECTION_NAME_SCHEMA,
        },
      },
      required: ['sections'],
    },
    isReadOnly: () => false,
    isConcurrencySafe: () => false,
    isEnabled: () => true,
    async prompt() {
      return 'Write section names (title / description / scope) into wiki.json.';
    },
    async call(input: ToolInputParams, _context: ToolContext): Promise<ToolResult> {
      try {
        const entries = Array.isArray(input.sections) ? (input.sections as unknown as Array<Record<string, unknown>>) : [];
        if (entries.length === 0) {
          return failResult('错误: sections 数组不能为空');
        }

        const result = await applySectionNames(entries as never, {
          variant,
          ...(options.onlyIds ? { onlyIds: options.onlyIds } : {}),
        });
        options.onResult?.(result);

        const lines = [
          `分类命名已写回：更新 ${result.updated}，scope ${result.scope} 条，跳过 ${result.skipped}，未知 id ${result.unknown}`,
          ...(result.unknown > 0 ? ['（未知 id 的提交已被丢弃；请只命名机器清单里给出的 id）'] : []),
          '（基础分类 overview / core 的 title / description 是系统固定值；缺失 id 的分类保留机器默认标题）',
        ];
        return okResult(lines.join('\n'));
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        return failResult(`写入分类命名失败: ${message}`);
      }
    },
  };
}

/**
 * Submit Pages Tool（页面命名阶段，按分类绑定）
 *
 * `section` 参数在 schema 中保留（模型需要确认自己在给哪个分类命名），
 * 但实际归并一律使用闭包绑定的机器页面清单——模型写错也不至于整段失败。
 */
export function createSubmitPagesTool(
  sectionTitle: string,
  machinePages: MachinePageEntry[],
  options: {
    variant?: BlueprintDetailLevel;
    /** 允许命名的机器页面 id（缺省 = 该分类全部；sync 只允许新增 id） */
    onlyIds?: Set<string>;
    onResult?: (result: ApplyPageNamesResult) => void;
  } = {},
): ToolDefinition {
  const variant = options.variant ?? 'high';
  const expectedIds = new Set(machinePages.map((entry) => entry.id));

  return {
    name: 'submit_pages',
    description: `提交分类「${sectionTitle}」的页面命名清单（只写 title / summary / group / level，slug 与文件归属由代码锁定）。`,
    inputSchema: {
      type: 'object',
      properties: {
        section: { type: 'string', description: `分类标题（必须为 "${sectionTitle}"）` },
        pages: {
          type: 'array',
          description: `该分类下机器页面的命名清单（id 必须来自机器清单；未知 id 会被丢弃）`,
          items: PAGE_NAME_SCHEMA,
        },
      },
      required: ['section', 'pages'],
    },
    isReadOnly: () => false,
    isConcurrencySafe: () => false,
    isEnabled: () => true,
    async prompt() {
      return `Submit page names for section "${sectionTitle}".`;
    },
    async call(input: ToolInputParams, _context: ToolContext): Promise<ToolResult> {
      try {
        const entries = Array.isArray(input.pages) ? (input.pages as unknown as Array<Record<string, unknown>>) : [];
        if (entries.length === 0) {
          return failResult('错误: pages 数组不能为空');
        }

        const incomingSection = typeof input.section === 'string' ? input.section.trim() : '';
        const mismatch =
          incomingSection && incomingSection.toLowerCase() !== sectionTitle.trim().toLowerCase()
            ? `\n（模型传入的分类 "${incomingSection}" 与预期 "${sectionTitle}" 不一致，已按预期分类写回）`
            : '';

        const result = await applyPageNames(entries as never, {
          variant,
          machinePages,
          ...(options.onlyIds ? { onlyIds: options.onlyIds } : {}),
        });
        options.onResult?.(result);

        return okResult(
          [
            `分类「${sectionTitle}」页面命名已写回：更新 ${result.updated}，跳过 ${result.skipped}，未知 id ${result.unknown}${mismatch}`,
            `该分类机器页面共 ${expectedIds.size} 个（缺失 id 的页面保留机器默认标题）`,
          ].join('\n'),
        );
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        return failResult(`写入页面命名失败: ${message}`);
      }
    },
  };
}
