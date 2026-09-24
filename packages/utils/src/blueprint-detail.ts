/**
 * 蓝图细节档位（blueprint.detail）的**常量与归一化**（无依赖模块）。
 *
 * 单独成文件的原因：`file-io.ts` 需要按档位拼 wiki 目录路径（变体），
 * 而 `config/index.ts` 依赖 `file-io.ts`（写配置）。若把档位常量留在 config，
 * 会形成 file-io ↔ config 循环；这里保持零依赖，两侧都从这里取。
 *
 * 档位语义（结构层的目标参数：分类数 / 每分类文章数）见 @zread-pi/types 的 BlueprintDetailLevel
 * 与 orchestrator 的 `agents/blueprint-detail.ts`（档位参数表）。
 */

import type { BlueprintConfig, BlueprintDetailLevel } from '@zread-pi/types';

/** 全部档位（顺序即配置界面 / 变体列表的展示顺序） */
export const BLUEPRINT_DETAIL_LEVELS: BlueprintDetailLevel[] = [
  'minimal',
  'low',
  'medium',
  'high',
  'max',
];

/** 旧 config.yaml 缺少 blueprint 段时的默认档位（老用户零变化） */
export const DEFAULT_BLUEPRINT_DETAIL: BlueprintDetailLevel = 'high';

/** 判断任意值是否是合法的蓝图细节档位 */
export function isBlueprintDetailLevel(value: unknown): value is BlueprintDetailLevel {
  return typeof value === 'string' && (BLUEPRINT_DETAIL_LEVELS as string[]).includes(value);
}

/** 归一化蓝图细节档位：非法/缺省值回退 high（旧配置无需迁移） */
export function normalizeBlueprintDetail(value: unknown): BlueprintDetailLevel {
  return isBlueprintDetailLevel(value) ? value : DEFAULT_BLUEPRINT_DETAIL;
}

/** 归一化蓝图配置：只保留 detail 一个字段，非法值回退 high */
export function normalizeBlueprintConfig(value: unknown): BlueprintConfig {
  const raw =
    value && typeof value === 'object' && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : {};
  return { detail: normalizeBlueprintDetail(raw.detail) };
}
