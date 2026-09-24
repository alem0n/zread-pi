/**
 * Blueprint Detail（蓝图细节档位）的纯函数层
 *
 * 结构优先蓝图里，档位是**机器目标参数**（plan D7）：
 *   - 区间数值不变，但语义从「硬校验」改为「目标」：
 *     `sections` 区间 → 结构层的选层窗口（Tmin / Tmax）；
 *     `topics` 区间 → targetPages = sections.max × perSection，决定 minSliceSize；
 *   - 越界不再触发归并 / 缩编回路（数量回路整体删除，D4）；
 *   - exhaustive / panorama 只影响提示词文案与内容门（minimal 的全景导览要求）。
 *
 * 本模块只放**纯函数与常量**：档位规格表 + 归一化取值 + minimal 的全景导览附加要求。
 *
 * 档位定义（见 @zread-pi/types 的 BlueprintDetailLevel）：
 * | 档位    | 分类数（目标） | 每分类文章数（目标） | 附加要求 |
 * |---------|----------------|----------------------|----------|
 * | minimal | 固定 1         | 固定 1               | 全景导览（必须 Mermaid 架构图），跳过两个命名 Agent（D16） |
 * | low     | 2~5            | 1~3                  | — |
 * | medium  | 3~6            | 3~5                  | — |
 * | high    | 3~8            | 3~10                 | —（默认） |
 * | max     | 3~8            | 5~12                 | 强调全面详尽 |
 */

import type { BlueprintDetailLevel } from '@zread-pi/types';
import { normalizeBlueprintDetail } from '@zread-pi/utils';

/** 分类 / 每分类文章的数量区间（目标参数） */
export interface DetailRange {
  min: number;
  max: number;
}

/** 单个档位的完整规格 */
export interface BlueprintDetailSpec {
  level: BlueprintDetailLevel;
  /** 分类数量区间（目标） */
  sections: DetailRange;
  /** 每分类文章（页面）数量区间（目标） */
  topics: DetailRange;
  /** minimal：页面提示词附加「全景导览」（必须 Mermaid 架构图梳理模块关系与数据流） */
  panorama: boolean;
  /** max：强调全面详尽 */
  exhaustive: boolean;
}

/** 档位规格表（顺序即配置界面展示顺序，由此处与 utils 的 BLUEPRINT_DETAIL_LEVELS 保持一致） */
export const BLUEPRINT_DETAIL_SPECS: Record<BlueprintDetailLevel, BlueprintDetailSpec> = {
  minimal: {
    level: 'minimal',
    sections: { min: 1, max: 1 },
    topics: { min: 1, max: 1 },
    panorama: true,
    exhaustive: false,
  },
  low: {
    level: 'low',
    sections: { min: 2, max: 5 },
    topics: { min: 1, max: 3 },
    panorama: false,
    exhaustive: false,
  },
  medium: {
    level: 'medium',
    sections: { min: 3, max: 6 },
    topics: { min: 3, max: 5 },
    panorama: false,
    exhaustive: false,
  },
  high: {
    level: 'high',
    sections: { min: 3, max: 8 },
    topics: { min: 3, max: 10 },
    panorama: false,
    exhaustive: false,
  },
  max: {
    level: 'max',
    sections: { min: 3, max: 8 },
    topics: { min: 5, max: 12 },
    panorama: false,
    exhaustive: true,
  },
};

/** 归一化档位并取规格（非法 / 缺省值回退 high） */
export function getDetailSpec(value: unknown): BlueprintDetailSpec {
  return BLUEPRINT_DETAIL_SPECS[normalizeBlueprintDetail(value)];
}

/** minimal 档位的全景导览附加要求（注入页面写作提示词；文案与旧版逐字一致） */
export const MINIMAL_PANORAMA_REQUIREMENT = [
  '## 全景导览附加要求（blueprint.detail = minimal）',
  '',
  '本篇是项目的**唯一**一篇全景导览文章，必须让读者只读这一篇就能建立对项目的完整认知：',
  '',
  '- **必须**使用 Mermaid 架构图梳理模块关系与数据流（```mermaid + `flowchart TB`）；节点标签一律用 quoted label（如 `A["核心模块"]`），禁止裸写带括号/路径/符号的标签；',
  '- 图中至少覆盖：入口层 → 核心模块 → 数据 / 存储 / 外部依赖的完整链路，并标注关键数据流方向；',
  '- 图之外用文字补充模块职责与协作关系（谁调用谁、为什么这样分层），不要只给一张图；',
  '- 仍然遵守通用溯源纪律：关键论述末尾给出 `Sources: [文件](路径#Lx-Ly)`。',
].join('\n');
