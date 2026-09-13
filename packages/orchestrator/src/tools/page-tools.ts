/**
 * Page Agent Tools
 *
 * Tools for Wiki page content generation.
 *
 * - write_page: Write Wiki page content to file with organized path structure
 *
 * Note: agent-runtime provides LsTool / GrepTool / GlobTool for directory listing and code search,
 * no need to duplicate here.
 */

import { resolve, dirname } from 'path';
import { defineTool, getRequiredString, getString } from '@zread-pi/agent-runtime';
import type { ToolInputParams, ToolContext, ToolDefinition } from '@zread-pi/agent-runtime';
import type { BlueprintDetailLevel } from '@zread-pi/types';
import { ensureDir, writeTextFile } from '@zread-pi/utils';

interface MermaidValidationIssue {
  block: number;
  line: number;
  nodeId: string;
  label: string;
}

interface MermaidBlock {
  code: string;
  startLine: number;
}

type PageToolResult = string | { data: string; is_error?: boolean };

const MERMAID_FENCE_RE = /^```[ \t]*mermaid[^\n]*\n([\s\S]*?)^```[ \t]*$/gim;
const FLOWCHART_HEADER_RE = /^(graph|flowchart)\b/i;
const FLOWCHART_NODE_LABEL_RE = /\b([A-Za-z_][\w-]*)\[([^\]\n]+)\]/g;
const LABEL_REQUIRES_QUOTES_RE = /[(){}|<>]/;

function extractMermaidBlocks(markdown: string): MermaidBlock[] {
  const blocks: MermaidBlock[] = [];
  let match: RegExpExecArray | null;

  MERMAID_FENCE_RE.lastIndex = 0;
  while ((match = MERMAID_FENCE_RE.exec(markdown)) !== null) {
    const beforeBlock = markdown.slice(0, match.index);
    blocks.push({
      code: match[1],
      startLine: beforeBlock.split('\n').length,
    });
  }

  return blocks;
}

function isFlowchart(code: string): boolean {
  const firstMeaningfulLine = code
    .split('\n')
    .map(line => line.trim())
    .find(line => line.length > 0 && !line.startsWith('%%'));

  return firstMeaningfulLine ? FLOWCHART_HEADER_RE.test(firstMeaningfulLine) : false;
}

function isQuotedLabel(label: string): boolean {
  const trimmed = label.trim();
  return (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  );
}

/**
 * Mermaid 校验（导出供 polish 后处理复用）：返回 flowchart 节点标签未加引号的问题列表。
 * WritePageTool 内部用它拦截非法图表；polish 用它判定是否回滚。
 */
export function validateMermaidContent(content: string): MermaidValidationIssue[] {
  const issues: MermaidValidationIssue[] = [];

  for (const [blockIndex, block] of extractMermaidBlocks(content).entries()) {
    if (!isFlowchart(block.code)) continue;

    for (const [lineIndex, line] of block.code.split('\n').entries()) {
      let match: RegExpExecArray | null;

      FLOWCHART_NODE_LABEL_RE.lastIndex = 0;
      while ((match = FLOWCHART_NODE_LABEL_RE.exec(line)) !== null) {
        const [, nodeId, label] = match;

        if (!isQuotedLabel(label) && LABEL_REQUIRES_QUOTES_RE.test(label)) {
          issues.push({
            block: blockIndex + 1,
            line: block.startLine + lineIndex,
            nodeId,
            label,
          });
        }
      }
    }
  }

  return issues;
}

/** 把校验问题格式化成可读的错误文本（工具错误与 polish 回滚告警共用同一文案） */
export function formatMermaidValidationError(issues: MermaidValidationIssue[]): string {
  const details = issues
    .map(issue =>
      `- Mermaid block ${issue.block}, line ${issue.line}: node "${issue.nodeId}" label contains Mermaid structural characters and must be quoted: ${issue.nodeId}["${issue.label}"]`,
    )
    .join('\n');

  return [
    'Mermaid validation failed.',
    'Flowchart node labels containing characters such as (), {}, |, or HTML tags must use quoted labels.',
    'Example: RC["reference-counter.ts<br/>引用计数器<br/>O(n) 文件索引"]',
    '',
    details,
  ].join('\n');
}

/**
 * 按 write_page 的路径规则解析页面输出路径（与工具内拼接规则保持一致）。
 *
 * - 传 `variant`（档位）时基准目录为 `.zread-pi/wiki/<variant>`（多档共存）；
 * - 不传 / null = 遗留 `.zread-pi/wiki`（只读兼容）；
 * - `file` 含路径分隔符 → 相对基准目录解析（忽略 `section`）
 * - `file` + `section` → `<基准>/<section>/<file>`
 * - 只有 `file` → `<基准>/<file>`
 * - 没有 `file` → `<基准>/<slug>.md`
 *
 * 单独导出，供 generate-wiki 的落盘兜底复用同一套解析规则。
 */
export function resolvePageOutputPath(
  cwd: string,
  params: { file?: string; section?: string; slug: string },
  options: { variant?: BlueprintDetailLevel | null } = {},
): string {
  const wikiDir = options.variant
    ? resolve(cwd, '.zread-pi/wiki', options.variant)
    : resolve(cwd, '.zread-pi/wiki');
  const { file, section, slug } = params;

  if (file) {
    if (file.includes('/') || file.includes('\\')) {
      return resolve(wikiDir, file);
    }
    if (section) {
      return resolve(wikiDir, section, file);
    }
    return resolve(wikiDir, file);
  }

  return resolve(wikiDir, `${slug}.md`);
}

/**
 * Write Page Tool
 *
 * Write Wiki page content to the specified file path.
 * Uses WikiPage.file field for path, organized by section.
 *
 * 路径结构（`variant` = 蓝图细节档位；不传 = 遗留布局）：
 * `.zread-pi/wiki[ /<variant>]/{section}/{file}`
 */
export function createWritePageTool(variant?: BlueprintDetailLevel | null): ToolDefinition {
  return defineTool({
    name: 'write_page',
    description: `将 Wiki 页面内容写入指定文件路径。按照章节组织目录结构。
输出路径: .zread-pi/wiki/{file}`,
    inputSchema: {
      type: 'object',
      properties: {
        slug: {
          type: 'string',
          description: '页面 slug（如 "1-project-overview"）',
        },
        file: {
          type: 'string',
          description: '文件名或相对路径，如 "1-project-overview.md"',
        },
        section: {
          type: 'string',
          description: '所属章节（如 "入门指南"），用于组织目录结构',
        },
        content: {
          type: 'string',
          description: 'Markdown 格式的页面内容',
        },
        title: {
          type: 'string',
          description: '页面标题（可选，用于 YAML frontmatter）',
        },
      },
      required: ['slug', 'content'],
    },
    isReadOnly: false,
    isConcurrencySafe: false, // Write operation needs exclusive access
    async call(input: ToolInputParams, context: ToolContext): Promise<PageToolResult> {
      const slug = getRequiredString(input, 'slug');
      const content = getRequiredString(input, 'content');
      const title = getString(input, 'title');
      const file = getString(input, 'file');
      const section = getString(input, 'section');

      // Build output path based on file and section
      // Priority: file parameter (with section if needed) > slug fallback
      const filePath = resolvePageOutputPath(context.cwd, { file, section, slug }, { variant });

      // Build YAML frontmatter
      const frontmatter = title
        ? `---\ntitle: "${title}"\nslug: "${slug}"\n---\n\n`
        : '';

      const fullContent = frontmatter + content;
      const mermaidIssues = validateMermaidContent(fullContent);
      if (mermaidIssues.length > 0) {
        return {
          data: JSON.stringify({
            success: false,
            error: formatMermaidValidationError(mermaidIssues),
          }),
          is_error: true,
        };
      }

      // Write file
      try {
        await ensureDir(dirname(filePath));
        await writeTextFile(filePath, fullContent);

        return JSON.stringify({
          success: true,
          path: filePath,
          slug,
          section: section || '未分类',
          size: fullContent.length,
        });
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        return {
          data: JSON.stringify({
            success: false,
            error: message,
          }),
          is_error: true,
        };
      }
    },
  });
}

/** 遗留布局（`wiki/<section>/<file>`）的 write_page 实例 */
export const WritePageTool: ToolDefinition = createWritePageTool();
