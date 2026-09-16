/**
 * JsonTree —— 轻量 JSON 折叠树（不引入新依赖；检查器展示工具参数 / 结果元信息用）。
 */

import { useState } from 'react';

interface JsonTreeProps {
  value: unknown;
  /** 初始展开层级（0 = 全部折叠） */
  defaultExpandedDepth?: number;
  className?: string;
}

function classNameOf(value: unknown): string {
  if (value === null) return 'text-gray-400';
  if (Array.isArray(value)) return 'text-emerald-600';
  if (typeof value === 'object') return 'text-indigo-600';
  if (typeof value === 'string') return 'text-amber-700';
  if (typeof value === 'number') return 'text-blue-600';
  if (typeof value === 'boolean') return 'text-purple-600';
  return 'text-gray-600';
}

function formatPrimitive(value: unknown): string {
  if (typeof value === 'string') return JSON.stringify(value);
  return String(value);
}

function summarize(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return `Array(${value.length})`;
  if (typeof value === 'object') {
    const entries = Object.keys(value as Record<string, unknown>);
    return `{${entries.length}}`;
  }
  return formatPrimitive(value);
}

function Node({
  name,
  value,
  depth,
  defaultExpandedDepth,
}: {
  name?: string;
  value: unknown;
  depth: number;
  defaultExpandedDepth: number;
}): React.ReactNode {
  const isObject = value !== null && typeof value === 'object';
  const [expanded, setExpanded] = useState(depth < defaultExpandedDepth);

  if (!isObject) {
    return (
      <div className="flex gap-2 py-0.5 font-mono text-xs leading-relaxed">
        {name !== undefined ? (
          <span className="text-gray-500">
            {JSON.stringify(name)}
            <span className="text-gray-400">:</span>
          </span>
        ) : null}
        <span className={classNameOf(value)}>{formatPrimitive(value)}</span>
      </div>
    );
  }

  const entries = Object.entries(value as Record<string, unknown>);
  const label = name !== undefined ? `${JSON.stringify(name)}: ` : '';

  if (entries.length === 0) {
    return (
      <div className="py-0.5 font-mono text-xs text-gray-400">
        {label}
        {Array.isArray(value) ? '[]' : '{}'}
      </div>
    );
  }

  return (
    <div className="py-0.5">
      <button
        type="button"
        onClick={() => setExpanded((current) => !current)}
        className="flex gap-1 font-mono text-xs text-left hover:bg-gray-100 dark:hover:bg-gray-800 rounded px-0.5 -mx-0.5"
      >
        <span className="text-gray-400 w-3 select-none">{expanded ? '▾' : '▸'}</span>
        <span className="text-gray-600">
          {label}
          <span className={classNameOf(value)}>{Array.isArray(value) ? `[${entries.length}]` : summarize(value)}</span>
        </span>
      </button>
      {expanded ? (
        <div className="pl-4 border-l border-gray-200 dark:border-gray-700 ml-1.5">
          {entries.map(([key, child]) => (
            <Node
              key={key}
              name={key}
              value={child}
              depth={depth + 1}
              defaultExpandedDepth={defaultExpandedDepth}
            />
          ))}
        </div>
      ) : null}
    </div>
  );
}

export function JsonTree({ value, defaultExpandedDepth = 1, className }: JsonTreeProps) {
  return (
    <div className={className}>
      <Node value={value} depth={0} defaultExpandedDepth={defaultExpandedDepth} />
    </div>
  );
}
