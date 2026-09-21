// apps/browse/src/types/wiki.ts

export type WikiLevel = 'Beginner' | 'Intermediate' | 'Advanced';

/** 蓝图细节档位（与后端 `blueprint.detail` 一致） */
export type BlueprintDetailLevel = 'minimal' | 'low' | 'medium' | 'high' | 'max';

export interface WikiPage {
  slug: string;
  title: string;
  file: string;
  section: string;
  group?: string;
  level: WikiLevel;
  associatedFiles?: string[];
}

export interface WikiOutput {
  id: string;
  generated_at: string;
  language: string;
  pages: WikiPage[];
  /** 生成时使用的档位 */
  detail: BlueprintDetailLevel;
  /**
   * 分类阶段产出的一级结构清单（权威阅读顺序）。
   *
   * 主题阶段按 section 并发执行，`pages` 数组的顺序是并发完成顺序，
   * 不是蓝图顺序；侧边目录树以本清单为准（旧 wiki.json 无该字段时回退
   * 到 pages 首现顺序）。
   */
  sections?: Array<{ title: string }>;
}

/** 一个可浏览的 wiki 变体（档位子目录） */
export interface WikiVariant {
  /** 档位名 */
  detail: BlueprintDetailLevel;
  name: string;
  generatedAt: string | null;
  pagesCount: number;
  sectionsCount: number | null;
}

/** GET /api/wiki/variants 的响应 */
export interface WikiVariantsResponse {
  variants: WikiVariant[];
  /** 缺省档位（未传 ?detail= 时服务端会解析到的档位；无任何变体时为 null） */
  active: BlueprintDetailLevel | null;
}

export interface TreeNode {
  /** 目录树只两级：类型（section）→ 文章（page） */
  type: 'section' | 'page';
  id: string;
  title: string;
  children?: TreeNode[];
  pageData?: WikiPage;
}

export interface CodeReference {
  fileName: string;
  filePath: string;
  lineStart?: number;
  lineEnd?: number;
}

export interface WikiState {
  wikiData: WikiOutput | null;
  currentPage: WikiPage | null;
  currentContent: string;
  references: CodeReference[];
  activeReference: CodeReference | null;
  leftPanelCollapsed: boolean;
  rightPanelCollapsed: boolean;
  sourceModalOpen: boolean;
  sourceModalRef: CodeReference | null;
  /** 全部可浏览的档位变体 */
  variants: WikiVariant[];
  /** 当前浏览的档位；null = 尚未加载 */
  detail: BlueprintDetailLevel | null;
}
