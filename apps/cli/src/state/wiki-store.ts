/**
 * WikiStore - wiki.json 状态（替代原 WikiProvider）
 *
 * 仅负责加载/重载 wiki.json，不包含业务逻辑。
 *
 * 多档共存布局（`wiki/<detail>/`）下的两个口径：
 * - `catalog` / `detail`：**活动变体**（首页展示、进度、浏览入口）——
 *   配置档位 → 遗留目录 → 第一个存在的档位；
 * - `targetCatalog` / `targetDetail`：**写盘目标**（生成 / 继续 / 同步）——
 *   始终是配置档位（遗留变体只读，不会被写）。
 */

import type { BlueprintDetailLevel, WikiOutput } from "@zread-pi/types";
import type { WikiVariantInfo } from "@zread-pi/utils";
import {
  fileExists,
  getWikiJsonPath,
  listWikiVariants,
  loadConfig,
  readJsonFile,
  resolveWikiVariant,
} from "@zread-pi/utils";

export class WikiStore {
  /** 活动变体的 catalog（首页展示 / 进度用；无任何变体时为 null） */
  catalog: WikiOutput | null = null;
  /** 活动变体：档位名或 null（遗留目录）；无任何变体时为 null */
  detail: BlueprintDetailLevel | null = null;
  /** 写盘目标档位（生成 / 强制重新生成 / 同步写入这里） */
  targetDetail: BlueprintDetailLevel = "high";
  /** 写盘目标档位的 catalog（活动变体不是配置档位时为 null → 视为「尚无目录」） */
  targetCatalog: WikiOutput | null = null;
  /** 所有已存在的变体元信息（含骨架 pages 为空的；头部文档状态行展示用） */
  variants: WikiVariantInfo[] = [];

  /** 重新加载（每次调用都重新解析变体，配置档位切换后进入页面即可生效） */
  async reload(): Promise<void> {
    let preferred: BlueprintDetailLevel = "high";
    try {
      preferred = (await loadConfig()).blueprint.detail;
    } catch {
      // 配置不可读时用默认档位（与 validateConfig 的回退一致）
    }

    this.variants = listWikiVariants();
    const resolved = resolveWikiVariant(preferred);
    this.detail = resolved === undefined ? null : resolved;
    this.targetDetail = preferred;

    const activePath = resolved === undefined ? null : getWikiJsonPath(resolved);
    this.catalog = activePath ? await this.readCatalog(activePath) : null;

    // 目标目录 = 配置档位本身；活动变体是遗留 / 其他档位时不复用其 catalog
    this.targetCatalog =
      resolved !== undefined && resolved !== null && resolved === preferred ? this.catalog : null;
  }

  /** 首次进入 wiki 区域时加载（等价原 WikiProvider 的挂载副作用） */
  async load(): Promise<void> {
    await this.reload();
  }

  private async readCatalog(path: string): Promise<WikiOutput | null> {
    try {
      if (!(await fileExists(path))) return null;
      return await readJsonFile<WikiOutput>(path);
    } catch {
      return null;
    }
  }
}
