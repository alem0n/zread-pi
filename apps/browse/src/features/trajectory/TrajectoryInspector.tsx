/**
 * TrajectoryInspector —— 本地检查器（选中记录的完整内容 / 载荷 / schema / 用量 / 时序）。
 *
 * 复用站内的 MarkdownRenderer 渲染正文；JSON 载荷用站内 JsonTree；
 * 请求导航在 requests 序列上前后跳转。
 */

import { memo, useMemo } from 'react';
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
import { useT } from '@/i18n/I18nContext';

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

export const TrajectoryInspector = memo(function TrajectoryInspector({
  cell,
  requests,
  onSelectSeq,
  width,
  onWidthChange,
}: TrajectoryInspectorProps) {
  const t = useT();
  const request = useMemo(
    () => (cell?.sourceSeq !== undefined ? requests.find((entry) => entry.seq === cell.sourceSeq) : undefined),
    [cell?.sourceSeq, requests],
  );

  const handleResize = (event: React.MouseEvent<HTMLDivElement>): void => {
    event.preventDefault();
    const startX = event.clientX;
    const startWidth = width;
    // 拖动期间禁用选区，否则拖到台账文本上会划出一串高亮
    const previousUserSelect = document.body.style.userSelect;
    document.body.style.userSelect = 'none';
    const move = (moveEvent: MouseEvent): void => {
      const delta = startX - moveEvent.clientX;
      onWidthChange(Math.max(DETAILS_MIN_WIDTH, Math.min(DETAILS_MAX_WIDTH, startWidth + delta)));
    };
    const up = (): void => {
      window.removeEventListener('mousemove', move);
      window.removeEventListener('mouseup', up);
      document.body.style.userSelect = previousUserSelect;
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
        {t('trajectory.selectRecord')}
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
        {cell.isError ? <span className="text-xs text-[#e54847]">{t('trajectory.error')}</span> : null}
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
            title={t('trajectory.prevRequest')}
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
            title={t('trajectory.nextRequest')}
          >
            <ChevronRight size={14} />
          </button>
        </div>
      </div>

      <div className="flex-1 overflow-y-auto">
        {cell.text !== '' ? (
          <Section title={t('trajectory.sections.summary')}>
            <div className="text-sm text-[#31302e] whitespace-pre-wrap break-words">{cell.text}</div>
          </Section>
        ) : null}

        {cell.inputDetail !== undefined ? (
          <Section title={cell.kind === 'user' ? t('trajectory.sections.prompt') : t('trajectory.sections.input')}>
            <div className="text-xs font-mono whitespace-pre-wrap break-words text-[#31302e] max-h-64 overflow-y-auto">
              {cell.inputDetail}
            </div>
          </Section>
        ) : null}

        {cell.outputDetail !== undefined ? (
          <Section title={cell.kind === 'tool' ? t('trajectory.sections.result') : t('trajectory.sections.output')}>
            <div className="text-xs font-mono whitespace-pre-wrap break-words text-[#31302e] max-h-72 overflow-y-auto">
              {cell.outputDetail}
            </div>
          </Section>
        ) : null}

        {cell.thinkingDetail !== undefined && cell.thinkingDetail !== '' ? (
          <Section title={t('trajectory.sections.thinking')}>
            <div className="text-xs font-mono whitespace-pre-wrap break-words text-[#615d59] max-h-64 overflow-y-auto">
              {cell.thinkingDetail}
            </div>
          </Section>
        ) : null}

        {cell.schemaDetail !== undefined ? (
          <Section title={t('trajectory.sections.toolSchema')}>
            <JsonTree value={safeParseJson(cell.schemaDetail)} defaultExpandedDepth={1} className="max-h-72 overflow-y-auto" />
          </Section>
        ) : null}

        {cell.sourceBlocks !== undefined && cell.sourceBlocks.length > 0 ? (
          <Section title={t('trajectory.sections.sourceBlocks')}>
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

        <Section title={t('trajectory.sections.usage')}>
          <MetricRow label={t('trajectory.metrics.started')} value={formatStartedAt(cell.startedAt ?? null)} />
          <MetricRow label={t('trajectory.metrics.duration')} value={cell.timeSeconds === null || cell.timeSeconds === undefined ? undefined : formatDurationMs(cell.timeSeconds * 1000)} />
          {ttft !== undefined ? <MetricRow label={t('trajectory.metrics.ttft')} value={ttft} /> : null}
          {decode !== undefined ? <MetricRow label={t('trajectory.metrics.decode')} value={decode} /> : null}
          <MetricRow label={t('trajectory.metrics.input')} value={formatTokens(cell.input)} />
          <MetricRow label={t('trajectory.metrics.output')} value={formatTokens(cell.output)} />
          {cell.cacheRead !== undefined && cell.cacheRead > 0 ? (
            <MetricRow label={t('trajectory.metrics.cacheRead')} value={formatTokens(cell.cacheRead)} />
          ) : null}
          {cell.cacheWrite !== undefined && cell.cacheWrite > 0 ? (
            <MetricRow label={t('trajectory.metrics.cacheWrite')} value={formatTokens(cell.cacheWrite)} />
          ) : null}
          {cell.cacheRead !== undefined && cell.cacheRead > 0 ? (
            <MetricRow
              label={t('trajectory.metrics.cacheHit')}
              value={formatPercent(
                cacheHitRatio({ input: cell.input, cacheRead: cell.cacheRead, cacheWrite: cell.cacheWrite }),
              )}
            />
          ) : null}
        </Section>

        {request !== undefined ? (
          <Section title={t('trajectory.sections.request')}>
            <MetricRow label={t('trajectory.metrics.requestNumber')} value={String(request.number)} />
            <MetricRow label={t('trajectory.metrics.turn')} value={request.turn === null ? '—' : String(request.turn)} />
            <MetricRow label={t('trajectory.metrics.step')} value={String(request.step)} />
            <MetricRow label={t('trajectory.metrics.status')} value={request.status} />
            {request.provider !== undefined ? <MetricRow label={t('trajectory.metrics.provider')} value={request.provider} /> : null}
            {request.model !== undefined ? <MetricRow label={t('trajectory.metrics.model')} value={request.model} /> : null}
            {request.contextWindow !== undefined ? (
              <MetricRow label={t('trajectory.metrics.contextWindow')} value={formatTokens(request.contextWindow)} />
            ) : null}
            {request.retry !== undefined ? (
              <MetricRow label={t('trajectory.metrics.retry')} value={`${request.retry}/${request.maxRetries} · ${request.retryDelayMs !== undefined ? formatDurationMillis(request.retryDelayMs) : '—'}`} />
            ) : null}
            {request.error !== undefined ? <MetricRow label={t('trajectory.metrics.error')} value={request.error} /> : null}
            {request.cumulativeUsage !== undefined ? (
              <MetricRow
                label={t('trajectory.metrics.cumulative')}
                value={`↑${formatTokens(request.cumulativeUsage.input)} ↓${formatTokens(request.cumulativeUsage.output)}`}
              />
            ) : null}
          </Section>
        ) : null}
      </div>
    </div>
  );
});

function safeParseJson(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}
