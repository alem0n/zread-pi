// apps/browse/src/components/WikiSidebar.tsx
import { useState } from 'react';
import { useNavigate } from 'react-router';
import { useWiki } from '@/hooks/useWiki';
import { BookOpen, ChevronDown, ChevronRight, ChevronUp, Layers, Activity } from 'lucide-react';
import type { BlueprintDetailLevel, TreeNode, WikiPage } from '@/types/wiki';

/** 档位展示名（与 CLI `/config/detail` 的文案保持一致） */
const DETAIL_LABELS: Record<BlueprintDetailLevel, string> = {
  minimal: '极简',
  low: '精简',
  medium: '标准',
  high: '详细',
  max: '最详尽',
};

/** 变体展示名：遗留目录 = 「默认」 */
function variantLabel(detail: BlueprintDetailLevel | null): string {
  if (detail === null) return '默认';
  return DETAIL_LABELS[detail] ?? detail;
}

interface TreeItemProps {
  node: TreeNode;
  level?: number;
  onSelectPage: (page: WikiPage) => void;
}

function TreeItem({ node, level = 0, onSelectPage }: TreeItemProps) {
  const { currentPage, expandedNodes, toggleNode } = useWiki();
  const isExpanded = expandedNodes.has(node.id);

  const isActive = node.type === 'page' && currentPage?.slug === node.pageData?.slug;

  const handlePageClick = () => {
    if (node.type === 'page' && node.pageData) {
      onSelectPage(node.pageData);
    }
  };

  // Section: 醒目标题，不可点击，不展开
  if (node.type === 'section') {
    const children = node.children ?? [];
    return (
      <div>
        <div
          className="py-2 text-sm font-semibold text-gray-900"
          style={{ paddingLeft: `${(level + 1) * 12}px` }}
        >
          {node.title}
        </div>
        {children.length > 0 && (
          <div>
            {children.map(child => (
              <TreeItem key={child.id} node={child} level={level + 1} onSelectPage={onSelectPage} />
            ))}
          </div>
        )}
      </div>
    );
  }

  // Group: 可展开的组
  if (node.type === 'group') {
    const children = node.children ?? [];
    return (
      <div>
        <div
          onClick={() => children.length > 0 && toggleNode(node.id)}
          className="flex items-center justify-between py-2 px-2 rounded-md cursor-pointer text-sm text-gray-700 hover:bg-gray-50 transition-colors duration-150"
          style={{ paddingLeft: `${(level + 1) * 12}px` }}
        >
          <span className="font-normal">{node.title}</span>
          {children.length > 0 && (
            <span className="text-gray-400">
              {isExpanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
            </span>
          )}
        </div>
        {children.length > 0 && isExpanded && (
          <div>
            {children.map(child => (
              <TreeItem key={child.id} node={child} level={level + 1} onSelectPage={onSelectPage} />
            ))}
          </div>
        )}
      </div>
    );
  }

  // Page: 普通页面项
  return (
    <div>
      <div
        onClick={handlePageClick}
        className={`
          py-2 px-2 rounded-md cursor-pointer text-sm
          transition-colors duration-150
          ${isActive
            ? 'bg-gray-100 text-gray-900'
            : 'text-gray-700 hover:bg-gray-50'
          }
        `}
        style={{ paddingLeft: `${(level + 1) * 12}px` }}
      >
        <span className="font-normal">{node.title}</span>
      </div>
    </div>
  );
}

export function WikiSidebar() {
  const { tree, leftPanelCollapsed, toggleLeftPanel, variants, detail, setDetail } = useWiki();
  const navigate = useNavigate();
  const [selectorOpen, setSelectorOpen] = useState(false);

  const handleSelectPage = (page: WikiPage) => {
    navigate(`/${page.slug}`);
  };

  // 切换档位：同 slug 页面保留，否则落到新档位首页
  const handleSelectVariant = async (next: BlueprintDetailLevel | null) => {
    setSelectorOpen(false);
    if (next === detail) return;
    const page = await setDetail(next);
    navigate(page ? `/${page.slug}` : '/');
  };

  if (leftPanelCollapsed) {
    return (
      <div className="w-12 h-full bg-white border-r border-gray-200 flex flex-col items-center py-4">
        <button
          onClick={toggleLeftPanel}
          className="p-2 rounded-md hover:bg-gray-100 text-gray-500"
        >
          <ChevronRight size={20} />
        </button>
      </div>
    );
  }

  return (
    <div className="w-64 h-full bg-white border-r border-gray-200 flex flex-col">
      {/* Header */}
      <div className="flex items-center justify-between p-4 border-b border-gray-100">
        <div className="flex items-center gap-2">
          <BookOpen size={22} className="text-blue-600" />
          <span className="font-semibold text-gray-900">Zread Wiki</span>
        </div>
        <button
          onClick={toggleLeftPanel}
          className="p-1.5 rounded-md hover:bg-gray-100 text-gray-400"
        >
          <ChevronLeft size={18} />
        </button>
      </div>

      {/* Tree */}
      <div className="flex-1 overflow-auto px-3 pb-4">
        {tree.map(node => (
          <TreeItem key={node.id} node={node} onSelectPage={handleSelectPage} />
        ))}
      </div>

      {/* 轨迹检查入口（最近一次运行的记录） */}
      <div className="border-t border-gray-100 p-3">
        <button
          onClick={() => navigate('/trajectory')}
          className="w-full flex items-center gap-2 px-2 py-1.5 rounded-md text-sm text-gray-700 hover:bg-gray-50 transition-colors duration-150"
        >
          <Activity size={14} className="text-gray-400" />
          <span>轨迹检查</span>
        </button>
      </div>

      {/* 档位选择器（列表向上弹出；无变体时不渲染） */}
      {variants.length > 0 && (
        <div className="relative border-t border-gray-100 p-3">
          {selectorOpen && (
            <div className="absolute bottom-full left-3 right-3 mb-2 rounded-lg border border-gray-200 bg-white shadow-lg overflow-hidden">
              {variants.map((variant) => {
                const isCurrent = variant.detail === detail;
                return (
                  <button
                    key={variant.legacy ? 'legacy' : variant.detail}
                    onClick={() => void handleSelectVariant(variant.detail)}
                    className={`
                      w-full flex items-center justify-between px-3 py-2 text-left text-sm
                      transition-colors duration-150
                      ${isCurrent ? 'bg-gray-100 text-blue-600 font-medium' : 'text-gray-700 hover:bg-gray-50'}
                    `}
                  >
                    <span>{variantLabel(variant.detail)}</span>
                    <span className="text-xs text-gray-400">{variant.pagesCount} 篇</span>
                  </button>
                );
              })}
            </div>
          )}
          <button
            onClick={() => setSelectorOpen((open) => !open)}
            className="w-full flex items-center justify-between px-2 py-1.5 rounded-md text-sm text-gray-700 hover:bg-gray-50 transition-colors duration-150"
          >
            <span className="flex items-center gap-2">
              <Layers size={14} className="text-gray-400" />
              <span>{variantLabel(detail)}</span>
            </span>
            <ChevronUp
              size={14}
              className={`text-gray-400 transition-transform duration-150 ${selectorOpen ? 'rotate-180' : ''}`}
            />
          </button>
        </div>
      )}
    </div>
  );
}

// ChevronLeft icon component
function ChevronLeft({ size, className }: { size: number; className?: string }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
    >
      <polyline points="15 18 9 12 15 6" />
    </svg>
  );
}
