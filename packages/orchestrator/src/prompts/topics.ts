/**
 * 主题阶段提示词（蓝图三阶段第二步）
 *
 * 数量目标由 `blueprint.detail` 档位参数化（见 agents/blueprint-detail.ts）：
 * - minimal：固定 1 篇（全景导览）；
 * - low：1~3 篇；medium：3~5 篇；high：3~10 篇；max：5~12 篇并鼓励深挖关联文件。
 */

import type { BlueprintDetailSpec } from '../agents/blueprint-detail.js';

export interface TopicsPromptOptions {
  spec: BlueprintDetailSpec;
}

/** 数量要求段落（按档位生成） */
function quantitySection(spec: BlueprintDetailSpec): string {
  if (spec.level === 'minimal') {
    return (
      '**数量**：固定 **1 篇**——minimal 档位只写一篇全景导览，把该分类的全部内容收敛到这一篇里（不要新增第二篇）。\n' +
      '**关联路径**：这一篇的 `associatedFiles` 要覆盖该分类最核心的入口与模块目录（1~6 个路径）。'
    );
  }
  if (spec.level === 'low') {
    return (
      '**数量**：当前分类建议规划 **1~3 篇**文章，不要把整个分类压缩成一篇，也不要为了凑数把同一主题硬拆成多篇。\n' +
      '**关联路径**：每篇文章的 `associatedFiles` 建议 1~4 个目录或核心文件；若功能高度浓缩在具体文件，必须精确到文件（如 `packages/core/src/scheduler.ts`），禁止粗暴地把父目录整体打包混入。'
    );
  }
  const deepDive = spec.exhaustive
    ? '\n**深挖关联路径（max 档位）**：鼓励探索更深层的关联文件——不只看入口文件，还要覆盖实现文件、类型定义与关键测试，为每篇文章建立完整的源码证据链；'
    : '';
  return (
    `**数量**：当前分类建议规划 **${spec.topics.min}~${spec.topics.max} 篇**文章——这是文章数是否充足的关键，不要把整个分类压缩成一两篇。\n` +
    '**关联路径**：每篇文章的 `associatedFiles` 建议 1~4 个目录或核心文件；若功能高度浓缩在具体文件，必须精确到文件（如 `packages/core/src/scheduler.ts`），禁止粗暴地把父目录整体打包混入。' +
    deepDive
  );
}

export function renderTopicsPrompt(options: TopicsPromptOptions): string {
  const { spec } = options;

  return `你是一位顶级的软件架构师。这是【蓝图三阶段】的第二步：为**当前这一个分类**规划文章主题（topic）草稿。

当前分类与它的说明、边界（scope）会写在下方「当前分类」一节，请只围绕该分类规划，不要越界到其它分类。

🚨 【核心原则：拒绝物理目录映射！】
你的目标不是枚举文件夹，而是提取"功能特性"。同一领域的多个平台/协议实现要拆成多篇文章，而不是塞进一篇。

## 范围锁定（scope，硬约束）

下方「当前分类」会给出该分类的 scope（包含 / 不包含清单）：

1. **只规划 \`包含\` 清单内的主题**：每个主题都必须能落进至少一条「包含」条目；
2. **\`不包含\` 清单点名的领域一律跳过**：它们属于其它分类——即使你在仓库里发现了相关代码，也不要写进本分类；
3. **同分类内不重复**：多个主题不得覆盖同一条「包含」内容（同一功能点的不同层次可以拆篇，但不能是同一层的重复）；
4. 若 scope 缺失（旧产物 / 模型未给），按 \`description\` 自行推断边界并守住它；规划完成后自查一遍：有没有主题落在「不包含」里？有则删掉或改写。

## 粒度规则

| 模块特征 | 拆分/聚合策略 |
|---------|--------------|
| **同一领域的不同平台/协议实现** | 🚫 严禁聚合在一篇！✅ 拆分为多篇文章，用 \`group\` 在侧边栏聚合 |
| **庞大生态的子系统** | 🚫 不要写成巨无霸文章！✅ 按生命周期/调度器/解析器拆成独立文章 |
| **细碎的 Utils / 常量** | ✅ 允许聚合，打包进"共享基础设施"类文章 |
| **高密度的核心机制 / 关键算法** | ✅ 即使只有 1~2 个文件，也必须独立成篇（如调度器、状态机、协议解析引擎） |

${quantitySection(spec)}

## 可用工具（三层 Repo Map）
- \`get_directory_tree\`：全局目录拓扑；
- \`get_core_signatures\`：高引用文件的导出签名；
- \`get_module_details\`：按需深挖某个模块的导出符号与注释。

**假设驱动调查**：先明确要验证的架构问题（例如"这个分类里的并发是在哪个文件收敛的？"），再用最小工具调用证实或推翻；拿到结果先归纳，再决定下一次调用。

## 输出规范

调用 \`submit_section_topics\` 提交本分类的主题列表，每个主题包含：

- \`title\`：**草稿标题**（文档语言），推荐"核心概念：具体功能"格式，≤20 字；
- \`summary\`：**一句话主题摘要**（≤40 字）：说明这篇要论证什么、以哪些文件为证据（例："以 scheduler.ts 与 task-queue.ts 为证，说明任务调度的优先级与超时收敛机制"）；它会被逐字注入页面写作提示词，作为范围锚点；
- \`slug\`：**英文 kebab-case 短名**（如 \`tcp-connection-pool\`），用于生成 URL，禁止中文拼音；
- \`group\`：可选，二级模块聚合（同分类下强相关的多篇用同一个 group 名捏在一起）；
- \`level\`：难度等级，取值 \`Beginner\` / \`Intermediate\` / \`Advanced\`；
- \`associatedFiles\`：支撑该主题的真实文件或目录路径（目录以 \`/\` 结尾）。

🚨 **标题视角**：必须是【产品架构能力视角】，禁止【底层代码包视角】。
- ❌ 错误："Net 网络包集成"、"Router 模块"、"CLI 工具提取"
- ✅ 正确："TCP 底层传输：高并发连接池机制"、"HTTP 路由栈：动态树形解析"、"系统脚手架与命令行工作流"

## 示例（仅演示 JSON 结构，切勿照搬内容名词）

\`\`\`json
{
  "section": "核心网络引擎",
  "topics": [
    {
      "title": "TCP 底层传输：高并发连接池管理器",
      "summary": "以 net/pool.ts 为证，论证连接复用、超时回收与背压如何共同支撑高并发传输",
      "slug": "tcp-connection-pool",
      "group": "底层传输协议",
      "level": "Advanced",
      "associatedFiles": ["packages/core/src/net/", "packages/types/src/socket.d.ts"]
    },
    {
      "title": "HTTP 路由栈：基于基数树的动态解析",
      "summary": "以 router/tree.ts 为证，说明基数树如何完成路由注册、参数提取与冲突消解",
      "slug": "http-router-parser",
      "group": "高层协议适配",
      "level": "Intermediate",
      "associatedFiles": ["packages/router/src/tree.ts", "packages/router/src/parser/"]
    }
  ]
}
\`\`\`

**最终警告**：\`section\` 字段必须与下方「当前分类」的标题完全一致；没有找到合理关联文件的主题宁可不写，也不要编造路径。
`;
}

/**
 * sync 主题阶段的追加规则（由 sync-wiki 拼在主题提示词之后）。
 *
 * 同步不做全量重排：既有页面必须原样带回 slug 与 title，以便代码复用原 slug/file；
 * 只允许新增页面，或基于 diff 调整既有页面的 associatedFiles / group / level。
 */
export const SYNC_TOPICS_RULES = `
## 同步追加规则（极其重要）

这是对**已生成 Wiki** 的增量同步，不是全量重新规划：

1. **旧的既有页面必须保留并原样带回**：清单里每一页都必须在 topics 里出现一次，且 \`slug\` 与 \`title\` 必须与旧清单**逐字一致**；若旧清单带了 \`summary\`，也必须逐字保留（它是页面写作的范围锚点，改写会导致锚点漂移）。可以更新 \`associatedFiles\` / \`group\` / \`level\`。
2. **只增不减**：代码会在必要时机械归档"关联文件已全部删除"的页面；你的清单里缺失的旧页面会被原样保留，所以不要试图用"删除"来实现重构。
3. **新增页面**：当变更文件引入了新的功能主题时，按正常粒度新增 topic（\`slug\` 用英文 kebab-case；不要与旧 slug 重复）。
4. **聚焦变更**：重点检查旧页面的 \`associatedFiles\` 是否需要跟着代码变更调整，避免把同一文件挂在多个不相干的页面上。
`;
