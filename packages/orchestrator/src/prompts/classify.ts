/**
 * 分类阶段提示词（蓝图三阶段第一步）
 *
 * 数量目标由 `blueprint.detail` 档位参数化（见 agents/blueprint-detail.ts）：
 * - minimal：固定 1 个分类（概览）；
 * - low / medium / high / max：走「基础分类 + 业务领域」结构，数量区间随档位变化。
 *
 * sync 的分类阶段传 `merge: true`：既有分类必留，新增优先并入既有。
 */

import type { BlueprintDetailSpec } from '../agents/blueprint-detail.js';

export interface ClassifyPromptOptions {
  spec: BlueprintDetailSpec;
  /** sync 合并模式（既有分类必留，只允许追加新分类） */
  merge?: boolean;
}

/** 数量要求段落（按档位生成） */
function quantitySection(spec: BlueprintDetailSpec, merge: boolean): string {
  if (spec.level === 'minimal') {
    return [
      '1. **数量固定 1 个**：只输出「概览」这一个分类——minimal 档位只写一篇全景导览，所有内容都必须收敛到这一篇里；',
      '2. **标题必须逐字为 `概览`**（文档语言为英文时为 `Overview`），description 说明这篇全景导览覆盖什么；',
      '3. **不要输出其余分类**：即使发现了独立的业务领域，也把它们作为概览文章的章节保留在 description 里。',
    ].join('\n');
  }

  const base =
    '2. **必须包含两个基础分类**（标题必须逐字一致）：\n' +
    '   - `概览`：项目定位、核心价值与整体速览；\n' +
    '   - `核心架构`：整体架构、核心模块职责与协作关系。';

  const mergeNote = merge
    ? '1. **sync 合并模式：既有分类必留**——已有分类的标题原样保留，新分类优先并入既有领域；总量（既有 + 新增）不得超过上限；'
    : `1. **数量 ${spec.sections.min}~${spec.sections.max} 个**：分类太少会把多个领域挤在一起，后续文章粒度会被迫变粗；${spec.exhaustive ? 'max 档位要求尽量覆盖全部功能领域；' : ''}`;

  return [
    mergeNote,
    base,
    '3. **其余分类按实际业务领域动态推导**，标题使用简洁中文（≤10 字），绝不照搬文件/文件夹名；',
    '4. **每个分类给一句 `description`**：说明这个分类覆盖什么、面向哪类读者——后续"分主题"阶段会依据它展开文章；',
    `5. **分类之间边界清晰**：不要把同一领域的多个实现塞进同一分类（它们应该拆成同分类下的多篇文章）；也不要让某个分类大到能装 ${spec.topics.max} 篇以上主题。`,
  ].join('\n');
}

/** 附加要求（仅 minimal / max 档位有） */
function extraSection(spec: BlueprintDetailSpec): string {
  if (spec.level === 'minimal') {
    return (
      '\n## 档位附加要求\n\n' +
      '本项目使用 **minimal** 档位：只产出 1 个「概览」分类，后续也只有 1 篇文章。' +
      '请把「架构暗线」的发现全部沉淀到概览的 description 里，供全景导览文章使用。\n'
    );
  }
  if (spec.exhaustive) {
    return (
      '\n## 档位附加要求\n\n' +
      '本项目使用 **max** 档位：强调**全面详尽**。请在数量上限内尽可能覆盖所有功能领域与架构暗线，' +
      '不遗漏任何有独立分析价值的子系统；同时保持分类之间高内聚、低重叠。\n'
    );
  }
  return '';
}

export function renderClassifyPrompt(options: ClassifyPromptOptions): string {
  const { spec, merge = false } = options;
  const mergeExtra = merge
    ? '\n## 同步追加规则\n\n这是对**已生成 Wiki** 的增量分类：不要重命名/删除既有分类，只补充确实无法归入既有分类的新分类。\n'
    : '';

  return `你是一位顶级的软件架构师和领域驱动设计（DDD）专家。这是【蓝图三阶段】的第一步：**只做顶级分类（section）**，不列具体文章。

🚨 【核心原则：拒绝物理目录映射！】
分类不是枚举文件夹，而是提取"功能领域"。例如"用户鉴权系统"可能横跨 \`packages/types/auth.ts\`、\`packages/core/src/auth/\` 和 \`apps/api/routes/auth.ts\`——它应该在概念上属于同一个分类。

## 分析框架：Why → What/How → Who
在动手调用工具之前，先按这个框架建立全局认知：
1. **Why（核心价值）**：这个项目解决什么问题？研究它的开发者能带走哪些可迁移的经验与设计模式？
2. **What/How（架构深潜）**：高层架构是什么？核心模块各自的单一职责是什么？哪些"架构暗线"（调度与并发、事件总线、上下文/依赖注入、错误与监控链路）值得独立成章？
3. **Who（受众校准）**：分类要服务不同类型读者——前端开发者关注渲染/状态，后端开发者关注 API/数据流/并发，算法工程师关注算法正确性与效率，初学者需要循序渐进的入门路径。

## 可用工具（三层 Repo Map）
- \`get_directory_tree\`：全局目录拓扑（极低 token）；
- \`get_core_signatures\`：高引用文件（Ref >= 5）的导出签名，用于理解核心 API 边界；
- \`get_module_details\`：按需深挖某个模块的导出符号与注释。

**假设驱动调查**：每次调用工具前先明确要验证的架构问题，禁止漫无目的地翻目录。通常 2~5 次工具调用足够完成分类。

## 输出规范

调用 \`submit_sections\` 输出分类清单，满足以下硬性要求：

${quantitySection(spec, merge)}

### 每个分类必须给出 \`scope\` 边界清单（防漂移硬性要求）

除 \`description\` 外，每个分类还必须给出 \`scope\` 数组，用「包含：…」/「不包含：…」两条式声明语义边界——它会逐级注入下游「分主题 / 标题 / 写作」阶段，成为分类的硬边界：

- **\`包含：\` 1~3 条**：本分类覆盖的功能领域（写具体机制 / 层次，不写文件路径）；
- **\`不包含：\` 1~3 条**：本分类**明确不覆盖**、最容易混进来的相邻领域，尽量以「（→ 相邻分类标题）」点名它应该属于哪个分类；
- **互斥**：同一领域只能被一个分类的「包含」收下，两个分类的 scope 不得互相包含；「不包含」条目是阻止分类之间互相抢内容的主要手段，宁可多写一条，也不要留空；
- scope 只约束语义范围，不是文章清单：不要在这里写页面 / 文章标题。

## 示例（虚拟的通用后端框架项目，仅演示结构，切勿照搬名词）

\`\`\`json
{
  "sections": [
    { "title": "概览", "description": "项目定位、核心特性与整体速览", "scope": ["包含：项目定位与核心价值", "包含：整体功能地图", "不包含：具体模块实现（→ 核心架构）"] },
    { "title": "核心架构", "description": "整体分层、模块协作与关键数据流", "scope": ["包含：整体分层与模块职责", "包含：关键数据流与调用链", "不包含：具体网络协议实现（→ 网络与协议栈）"] },
    { "title": "网络与协议栈", "description": "传输层、路由解析与协议适配的实现机制", "scope": ["包含：传输层与连接管理", "包含：路由解析与协议适配", "不包含：数据持久化模型（→ 数据与持久化）"] },
    { "title": "数据与持久化", "description": "ORM、连接池与事务模型", "scope": ["包含：ORM 与查询构建", "包含：连接池与事务模型", "不包含：网络传输实现（→ 网络与协议栈）"] },
    { "title": "周边工具与生态", "description": "CLI 脚手架、插件机制与部署工具", "scope": ["包含：CLI 与脚手架", "包含：插件机制", "不包含：运行时核心机制（→ 核心架构）"] }
  ]
}
\`\`\`

**最终警告**：这一步只输出分类，不要输出页面/文章列表；每个分类的 scope 必须写全（包含 / 不包含）。请像一位拥有 10 年经验的 CTO 一样审视代码：分类是 Wiki 的骨架，必须高内聚、易导航、给后续每个分类留出 ${spec.topics.min}~${spec.topics.max} 篇文章的空间。
${extraSection(spec)}${mergeExtra}`;
}
