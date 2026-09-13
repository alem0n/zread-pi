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
  /** 生成时使用的档位（遗留 wiki.json 无该字段） */
  detail?: BlueprintDetailLevel;
}

/** 一个可浏览的 wiki 变体（档位子目录或遗留目录） */
export interface WikiVariant {
  /** 档位名；null = 遗留目录（界面显示为「默认」） */
  detail: BlueprintDetailLevel | null;
  name: string;
  legacy: boolean;
  generatedAt: string | null;
  pagesCount: number;
  sectionsCount: number | null;
}

/** GET /api/wiki/variants 的响应 */
export interface WikiVariantsResponse {
  variants: WikiVariant[];
  /** 缺省档位（未传 ?detail= 时服务端会解析到的档位；null = 遗留目录） */
  active: BlueprintDetailLevel | null;
}

export interface TreeNode {
  type: 'section' | 'group' | 'page';
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
  expandedNodes: Set<string>;
  sourceModalOpen: boolean;
  sourceModalRef: CodeReference | null;
  /** 全部可浏览的档位变体（遗留目录的 detail 为 null） */
  variants: WikiVariant[];
  /** 当前浏览的档位；null = 遗留目录（「默认」） */
  detail: BlueprintDetailLevel | null;
}
