/**
 * TrajectoryInspector —— 本地检查器（选中记录的完整内容 / 载荷 / schema / 用量 / 时序）。
 *
 * 复用站内的 MarkdownRenderer 渲染正文；JSON 载荷用站内 JsonTree；
 * 请求导航在 requests 序列上前后跳转。
 */

import { useMemo } from 'react';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import {
  DETAILS_MAX_WIDTH,
  DETAILS_MIN_WIDTH,
  formatDurationMs,
  formatDurationMillis,
  formatPercent,
  formatStartedAt,
  formatTokens,
  cacheHitRatio,
  type TrajectoryCellProps,
  type TrajectoryRequestNumber,
} from '@zread-pi/trajectory';
import { JsonTree } from './JsonTree';

interface TrajectoryInspectorProps {
  cell: TrajectoryCellProps | null;
  requests: readonly TrajectoryRequestNumber[];
  onSelectSeq: (seq: number) => void;
  width: number;
  onWidthChange: (width: number) => void;
}

function MetricRow({ label, value }: { label: string; value: string | undefined }): React.ReactNode {
  if (value === undefined || value === '') return null;
  return (
    <div className="flex gap-2 text-xs py-0.5">
      <span className="w-20 shrink-0 text-[#a39e98]">{label}</span>
      <span className="font-mono text-[#31302e] break-all">{value}</span>
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }): React.ReactNode {
  return (
    <div className="border-t border-gray-200 px-3 py-2">
      <div className="text-[11px] font-semibold uppercase tracking-wide text-[#a39e98] mb-1.5">{title}</div>
      {children}
    </div>
  );
}

export function TrajectoryInspector({
  cell,
  requests,
  onSelectSeq,
  width,
  onWidthChange,
}: TrajectoryInspectorProps) {
  const request = useMemo(
    () => (cell?.sourceSeq !== undefined ? requests.find((entry) => entry.seq === cell.sourceSeq) : undefined),
    [cell?.sourceSeq, requests],
  );

  const handleResize = (event: React.MouseEvent<HTMLDivElement>): void => {
    event.preventDefault();
    const startX = event.clientX;
    const startWidth = width;
    const move = (moveEvent: MouseEvent): void => {
      const delta = startX - moveEvent.clientX;
      onWidthChange(Math.max(DETAILS_MIN_WIDTH, Math.min(DETAILS_MAX_WIDTH, startWidth + delta)));
    };
    const up = (): void => {
      window.removeEventListener('mousemove', move);
      window.removeEventListener('mouseup', up);
    };
    window.addEventListener('mousemove', move);
    window.addEventListener('mouseup', up);
  };

  if (cell === null) {
    return (
      <div
        style={{ width }}
        className="shrink-0 border-l border-gray-200 bg-white flex items-center justify-center text-sm text-[#a39e98]"
      >
        Select a record to inspect
      </div>
    );
  }

  const metrics = cell.assistantMetrics;
  const ttft =
    metrics?.firstTokenTime !== null && metrics?.firstTokenTime !== undefined && metrics.stepStartTime !== null
      ? formatDurationMs(metrics.firstTokenTime - metrics.stepStartTime)
      : undefined;
  const decode =
    metrics?.completedTime !== null && metrics?.completedTime !== undefined && metrics?.firstTokenTime !== null
      ? formatDurationMs(metrics.completedTime - metrics.firstTokenTime)
      : undefined;

  return (
    <div style={{ width }} className="shrink-0 border-l border-gray-200 bg-white flex flex-col relative">
      <div
        onMouseDown={handleResize}
        className="absolute -left-1 top-0 bottom-0 w-2 cursor-ew-resize z-10 hover:bg-[#0075de]/20"
      />
      <div className="flex items-center gap-2 px-3 py-2 border-b border-gray-200 bg-[#f6f5f4]">
        <span className="text-xs font-mono text-[#a39e98]">#{cell.index}</span>
        <span className="text-sm font-semibold text-[#31302e] uppercase">{cell.kind}</span>
        {cell.isError ? <span className="text-xs text-[#e54847]">error</span> : null}
        <div className="ml-auto flex items-center gap-1">
          <button
            type="button"
            onClick={() => {
              if (request === undefined) return;
              const index = requests.indexOf(request);
              const previous = requests[index - 1];
              if (previous?.seq !== undefined) onSelectSeq(previous.seq);
            }}
            disabled={request === undefined || requests.indexOf(request) <= 0}
            className="p-1 rounded hover:bg-gray-200 disabled:opacity-30 disabled:cursor-not-allowed"
            title="Previous request"
          >
            <ChevronLeft size={14} />
          </button>
          <button
            type="button"
            onClick={() => {
              if (request === undefined) return;
              const index = requests.indexOf(request);
              const next = requests[index + 1];
              if (next?.seq !== undefined) onSelectSeq(next.seq);
            }}
            disabled={request === undefined || requests.indexOf(request) >= requests.length - 1}
            className="p-1 rounded hover:bg-gray-200 disabled:opacity-30 disabled:cursor-not-allowed"
            title="Next request"
          >
            <ChevronRight size={14} />
          </button>
        </div>
      </div>

      <div className="flex-1 overflow-y-auto">
        {cell.text !== '' ? (
          <Section title="Summary">
            <div className="text-sm text-[#31302e] whitespace-pre-wrap break-words">{cell.text}</div>
          </Section>
        ) : null}

        {cell.inputDetail !== undefined ? (
          <Section title={cell.kind === 'user' ? 'Prompt' : 'Input'}>
            <div className="text-xs font-mono whitespace-pre-wrap break-words text-[#31302e] max-h-64 overflow-y-auto">
              {cell.inputDetail}
            </div>
          </Section>
        ) : null}

        {cell.outputDetail !== undefined ? (
          <Section title={cell.kind === 'tool' ? 'Result' : 'Output'}>
            <div className="text-xs font-mono whitespace-pre-wrap break-words text-[#31302e] max-h-72 overflow-y-auto">
              {cell.outputDetail}
            </div>
          </Section>
        ) : null}

        {cell.thinkingDetail !== undefined && cell.thinkingDetail !== '' ? (
          <Section title="Thinking">
            <div className="text-xs font-mono whitespace-pre-wrap break-words text-[#615d59] max-h-64 overflow-y-auto">
              {cell.thinkingDetail}
            </div>
          </Section>
        ) : null}

        {cell.schemaDetail !== undefined ? (
          <Section title="Tool schema">
            <JsonTree value={safeParseJson(cell.schemaDetail)} defaultExpandedDepth={1} className="max-h-72 overflow-y-auto" />
          </Section>
        ) : null}

        {cell.sourceBlocks !== undefined && cell.sourceBlocks.length > 0 ? (
          <Section title="Source blocks">
            <div className="space-y-1">
              {cell.sourceBlocks.map((block, index) => (
                <div key={index} className="text-xs">
                  <div className="font-mono text-[#a39e98]">
                    {block.type}
                    {block.toolName !== undefined ? ` · ${block.toolName}` : ''}
                  </div>
                  {block.imageSrc !== undefined ? (
                    <img src={block.imageSrc} alt={block.imageAlt ?? ''} className="max-w-full rounded border border-gray-200 my-1" />
                  ) : (
                    <div className="font-mono text-[#31302e] whitespace-pre-wrap break-words max-h-32 overflow-y-auto">
                      {block.content}
                    </div>
                  )}
                </div>
              ))}
            </div>
          </Section>
        ) : null}

        <Section title="Usage & timing">
          <MetricRow label="Started" value={formatStartedAt(cell.startedAt ?? null)} />
          <MetricRow label="Duration" value={cell.timeSeconds === null || cell.timeSeconds === undefined ? undefined : formatDurationMs(cell.timeSeconds * 1000)} />
          {ttft !== undefined ? <MetricRow label="TTFT" value={ttft} /> : null}
          {decode !== undefined ? <MetricRow label="Decode" value={decode} /> : null}
          <MetricRow label="Input" value={formatTokens(cell.input)} />
          <MetricRow label="Output" value={formatTokens(cell.output)} />
          {cell.cacheRead !== undefined && cell.cacheRead > 0 ? (
            <MetricRow label="Cache read" value={formatTokens(cell.cacheRead)} />
          ) : null}
          {cell.cacheWrite !== undefined && cell.cacheWrite > 0 ? (
            <MetricRow label="Cache write" value={formatTokens(cell.cacheWrite)} />
          ) : null}
          {cell.cacheRead !== undefined && cell.cacheRead > 0 ? (
            <MetricRow
              label="Cache hit"
              value={formatPercent(
                cacheHitRatio({ input: cell.input, cacheRead: cell.cacheRead, cacheWrite: cell.cacheWrite }),
              )}
            />
          ) : null}
        </Section>

        {request !== undefined ? (
          <Section title="Request">
            <MetricRow label="Request #" value={String(request.number)} />
            <MetricRow label="Turn" value={request.turn === null ? '—' : String(request.turn)} />
            <MetricRow label="Step" value={String(request.step)} />
            <MetricRow label="Status" value={request.status} />
            {request.provider !== undefined ? <MetricRow label="Provider" value={request.provider} /> : null}
            {request.model !== undefined ? <MetricRow label="Model" value={request.model} /> : null}
            {request.contextWindow !== undefined ? (
              <MetricRow label="Context win" value={formatTokens(request.contextWindow)} />
            ) : null}
            {request.retry !== undefined ? (
              <MetricRow label="Retry" value={`${request.retry}/${request.maxRetries} · ${request.retryDelayMs !== undefined ? formatDurationMillis(request.retryDelayMs) : '—'}`} />
            ) : null}
            {request.error !== undefined ? <MetricRow label="Error" value={request.error} /> : null}
            {request.cumulativeUsage !== undefined ? (
              <MetricRow
                label="Cumulative"
                value={`↑${formatTokens(request.cumulativeUsage.input)} ↓${formatTokens(request.cumulativeUsage.output)}`}
              />
            ) : null}
          </Section>
        ) : null}
      </div>
    </div>
  );
}

function safeParseJson(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}
