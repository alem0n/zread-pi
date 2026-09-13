// apps/browse/src/context/WikiContext.tsx
import React, { createContext, useState, useCallback, useMemo, useEffect } from 'react';
import { wikiApi } from '@/utils/api';
import type {
  BlueprintDetailLevel,
  WikiOutput,
  WikiPage,
  WikiVariant,
  CodeReference,
  WikiState,
} from '@/types/wiki';
import { buildTree } from '@/utils/buildTree';
import { parseReferences } from '@/utils/parseReferences';

interface WikiContextValue extends WikiState {
  tree: ReturnType<typeof buildTree>;
  loadWikiData: () => Promise<void>;
  selectPage: (page: WikiPage) => Promise<void>;
  /** 切换档位变体：重拉 catalog，同 slug 页面保留，否则落到新档位首页；返回落点页面 */
  setDetail: (detail: BlueprintDetailLevel | null) => Promise<WikiPage | null>;
  toggleNode: (nodeId: string) => void;
  toggleLeftPanel: () => void;
  toggleRightPanel: () => void;
  selectReference: (ref: CodeReference | null) => void;
  loadSourceCode: (filePath: string, lineStart?: number, lineEnd?: number) => Promise<string | null>;
  openSourceModal: (ref: CodeReference) => void;
  closeSourceModal: () => void;
}

const WikiContext = createContext<WikiContextValue | null>(null);

export { WikiContext };

// Helper to collect all group node IDs
function collectGroupIds(nodes: ReturnType<typeof buildTree>): Set<string> {
  const groupIds = new Set<string>();
  const traverse = (nodeList: typeof nodes) => {
    for (const node of nodeList) {
      if (node.type === 'group') {
        groupIds.add(node.id);
      }
      if (node.children) {
        traverse(node.children);
      }
    }
  };
  traverse(nodes);
  return groupIds;
}

export function WikiProvider({ children }: { children: React.ReactNode }) {
  const [wikiData, setWikiData] = useState<WikiOutput | null>(null);
  const [currentPage, setCurrentPage] = useState<WikiPage | null>(null);
  const [currentContent, setCurrentContent] = useState('');
  const [references, setReferences] = useState<CodeReference[]>([]);
  const [activeReference, setActiveReference] = useState<CodeReference | null>(null);
  const [leftPanelCollapsed, setLeftPanelCollapsed] = useState(false);
  const [rightPanelCollapsed, setRightPanelCollapsed] = useState(false);
  const [expandedNodes, setExpandedNodes] = useState<Set<string>>(new Set());
  const [initialLoadComplete, setInitialLoadComplete] = useState(false);
  const [sourceModalOpen, setSourceModalOpen] = useState(false);
  const [sourceModalRef, setSourceModalRef] = useState<CodeReference | null>(null);
  const [variants, setVariants] = useState<WikiVariant[]>([]);
  const [detail, setDetailState] = useState<BlueprintDetailLevel | null>(null);

  const tree = useMemo(() => (wikiData ? buildTree(wikiData.pages) : []), [wikiData]);

  // Load source code from API（源码属项目级，但显式传当前档位以便服务端校验）
  const loadSourceCode = useCallback(
    async (filePath: string, lineStart?: number, lineEnd?: number) => {
      try {
        const result = await wikiApi.getSource(filePath, lineStart, lineEnd, detail);
        return result.code;
      } catch (error) {
        console.error('Error loading source code:', error);
        return null;
      }
    },
    [detail],
  );

  const selectPage = useCallback(
    async (page: WikiPage) => {
      setCurrentPage(page);

      try {
        // Load wiki content from API（按当前档位变体解析页面文件）
        const data = await wikiApi.getContent(page.slug, detail);
        setCurrentContent(data.content);

        // Parse references from markdown content
        const refs = parseReferences(data.content);
        setReferences(refs);
        setActiveReference(refs[0] || null);
      } catch (error) {
        console.error('Error loading page content:', error);
        setCurrentContent('# Error\n\nFailed to load page content.');
        setReferences([]);
        setActiveReference(null);
      }
    },
    [detail],
  );

  const loadWikiData = useCallback(async () => {
    try {
      // 1) 拉取档位变体清单（一个都没有时退回「不带 detail」的默认解析）
      const payload = await wikiApi.getVariants().catch(() => null);
      const list = payload?.variants ?? [];
      setVariants(list);

      const hasActive = list.length > 0;
      const active = hasActive ? (payload?.active ?? null) : undefined;
      setDetailState(hasActive ? (active ?? null) : null);

      // 2) 按活动档位拉 catalog
      const data = await wikiApi.getCatalog(active);
      setWikiData(data);
      setInitialLoadComplete(true);
    } catch (error) {
      console.error('Error loading wiki data:', error);
    }
  }, []);

  /**
   * 切换档位：重拉该档位的 catalog；
   * 当前页在新档位存在同 slug 页面则停留，否则落第一篇（返回给调用方导航）。
   */
  const setDetail = useCallback(
    async (next: BlueprintDetailLevel | null): Promise<WikiPage | null> => {
      try {
        const data = await wikiApi.getCatalog(next);
        setWikiData(data);
        setDetailState(next);

        const sameSlug = currentPage
          ? data.pages.find((page) => page.slug === currentPage.slug)
          : undefined;
        const target = sameSlug ?? data.pages[0] ?? null;

        if (target) {
          await selectPageForDetail(target, next);
        } else {
          setCurrentPage(null);
          setCurrentContent('');
          setReferences([]);
          setActiveReference(null);
        }
        return target;
      } catch (error) {
        console.error('Error switching wiki variant:', error);
        return null;
      }
    },
    // selectPageForDetail 是稳定的内部函数；依赖当前页即可
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [currentPage],
  );

  // 切换档位时用目标档位拉正文（selectPage 闭包里的 detail 还是旧值）
  const selectPageForDetail = useCallback(
    async (page: WikiPage, targetDetail: BlueprintDetailLevel | null) => {
      setCurrentPage(page);
      try {
        const data = await wikiApi.getContent(page.slug, targetDetail);
        setCurrentContent(data.content);
        const refs = parseReferences(data.content);
        setReferences(refs);
        setActiveReference(refs[0] || null);
      } catch (error) {
        console.error('Error loading page content:', error);
        setCurrentContent('# Error\n\nFailed to load page content.');
        setReferences([]);
        setActiveReference(null);
      }
    },
    [],
  );

  // Select first page after data is loaded
  useEffect(() => {
    if (initialLoadComplete && wikiData && wikiData.pages.length > 0 && !currentPage) {
      const timer = setTimeout(() => {
        selectPage(wikiData.pages[0]);
      }, 0);
      return () => clearTimeout(timer);
    }
  }, [initialLoadComplete, wikiData, currentPage, selectPage]);

  // Expand all groups whenever the tree changes（含切换档位后的新目录树）
  useEffect(() => {
    if (tree.length > 0) {
      const groupIds = collectGroupIds(tree);
      const timer = setTimeout(() => {
        setExpandedNodes(groupIds);
      }, 0);
      return () => clearTimeout(timer);
    }
  }, [tree]);

  const toggleNode = useCallback((nodeId: string) => {
    setExpandedNodes((prev) => {
      const next = new Set(prev);
      if (next.has(nodeId)) {
        next.delete(nodeId);
      } else {
        next.add(nodeId);
      }
      return next;
    });
  }, []);

  const toggleLeftPanel = useCallback(() => {
    setLeftPanelCollapsed((prev) => !prev);
  }, []);

  const toggleRightPanel = useCallback(() => {
    setRightPanelCollapsed((prev) => !prev);
  }, []);

  const selectReference = useCallback((ref: CodeReference | null) => {
    setActiveReference(ref);
  }, []);

  const openSourceModal = useCallback((ref: CodeReference) => {
    setSourceModalRef(ref);
    setSourceModalOpen(true);
  }, []);

  const closeSourceModal = useCallback(() => {
    setSourceModalOpen(false);
    setSourceModalRef(null);
  }, []);

  const value: WikiContextValue = {
    wikiData,
    currentPage,
    currentContent,
    references,
    activeReference,
    leftPanelCollapsed,
    rightPanelCollapsed,
    expandedNodes,
    tree,
    variants,
    detail,
    loadWikiData,
    selectPage,
    setDetail,
    toggleNode,
    toggleLeftPanel,
    toggleRightPanel,
    selectReference,
    loadSourceCode,
    sourceModalOpen,
    sourceModalRef,
    openSourceModal,
    closeSourceModal
  };

  return (
    <WikiContext.Provider value={value}>
      {children}
    </WikiContext.Provider>
  );
}
