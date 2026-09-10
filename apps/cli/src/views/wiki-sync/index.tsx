/**
 * WikiSyncPage — Wiki 同步页面（两段布局）
 *
 * 顶部：── 目录 ──            状态行
 * 底部：── 文章 X/Y ──        SelectInput 列表，行末附变更 tag
 */
import { Box, Text, useInput } from 'ink';
import { useMemo, useCallback, useRef } from 'react';
import { useNavigate } from 'react-router';
import SelectInput from 'ink-select-input';
import Divider from '../../components/Divider';
import StatusRow from '../../components/StatusRow';
import StatusIcon from '../../components/StatusIcon';
import { formatBytes, formatDuration } from '../../utils';
import { theme } from '../../theme';
import { useI18n } from '../../i18n';
import { useWikiSync } from './hooks/use-wiki-sync';
import type { SyncCatalogState, SyncPageState } from './types';

export default function WikiSyncPage() {
  const navigate = useNavigate();
  const { t } = useI18n();
  const { state, actions } = useWikiSync();
  const { catalog, articles, syncPages } = state;

  // 选中文章 slug，用于按 r 重新生成
  const selectedSlugRef = useRef<string | null>(null);

  useInput((input, key) => {
    if (key.escape) {
      navigate('/wiki');
      return;
    }
    if (input === 'r') {
      // 目录失败：重新触发整个同步流程
      if (catalog.status === 'failed') {
        actions.retrySync();
        return;
      }
      // 选中某篇文章：重新生成该文章
      if (selectedSlugRef.current) {
        actions.regeneratePage(selectedSlugRef.current);
      }
    }
  });

  const handleArticleHighlight = useCallback((slug: string) => {
    selectedSlugRef.current = slug;
  }, []);

  const completedCount = articles.completedCount;
  const totalCount = syncPages.length;

  return (
    <Box flexDirection="column">
      <CatalogRow catalog={catalog} t={t} />

      {catalog.status === 'completed' && syncPages.length > 0 && (
        <ArticlesList
          pages={syncPages}
          statusMap={articles.pages}
          completedCount={completedCount}
          totalCount={totalCount}
          onHighlight={handleArticleHighlight}
          t={t}
        />
      )}

      {catalog.status === 'completed' && syncPages.length === 0 && (
        <Box marginTop={1}>
          <Text color={theme.muted}>无变更</Text>
        </Box>
      )}

      <Box marginTop={1}>
        <Text dimColor>
          ↑/↓: {t('wikiGenerate.navigate')} | r: {t('wikiGenerate.retry')} |
          ctrl+c: {t('wikiGenerate.exit')} | ESC: 返回
        </Text>
      </Box>
    </Box>
  );
}

// ——— 目录段 ———

interface CatalogRowProps {
  catalog: SyncCatalogState;
  t: ReturnType<typeof useI18n>['t'];
}

function CatalogRow({ catalog, t }: CatalogRowProps) {
  const { status, phase, usage, durationMs, error } = catalog;

  let statusText: string;
  if (status === 'loading') {
    statusText = phase === 'detecting' ? '扫描变更'
               : phase === 'planning'  ? '规划目录'
               : t('wikiGenerate.requesting');
  } else if (status === 'failed' && error) {
    statusText = error;
  } else {
    statusText = t(`wikiGenerate.${status}`);
  }

  let rightText = `[${statusText}]`;
  if (status === 'loading' && usage) {
    if (usage.input_tokens > 0)  rightText += ` ↑${formatBytes(usage.input_tokens)}`;
    if (usage.output_tokens > 0) rightText += ` ↓${formatBytes(usage.output_tokens)}`;
  }
  if (status === 'completed') {
    if (durationMs !== undefined) rightText += ` ${formatDuration(durationMs)}`;
    if (usage) {
      if (usage.input_tokens > 0)  rightText += ` ↑${formatBytes(usage.input_tokens)}`;
      if (usage.output_tokens > 0) rightText += ` ↓${formatBytes(usage.output_tokens)}`;
    }
  }

  const rightColor =
    status === 'loading'   ? theme.warning :
    status === 'completed' ? theme.success :
    status === 'failed'    ? theme.error   :
    theme.muted;

  const left = (
    <Box>
      <StatusIcon status={status} />
      <Text> {t('wikiGenerate.catalogTitle')}</Text>
    </Box>
  );

  return (
    <Box flexDirection="column">
      <Divider title={t('wikiGenerate.catalogTitle')} />
      <StatusRow left={left} right={<Text color={rightColor}>{rightText}</Text>} />
    </Box>
  );
}

// ——— 文章段 ———

interface ArticlesListProps {
  pages: { slug: string; title: string; status?: string }[];
  statusMap: Record<string, SyncPageState>;
  completedCount: number;
  totalCount: number;
  onHighlight?: (slug: string) => void;
  t: ReturnType<typeof useI18n>['t'];
}

const tagColor = (type?: string): string | undefined => {
  switch (type) {
    case 'new':      return '#1aae39';
    case 'updated':  return '#dd5b00';
    case 'archived': return '#a39e98';
    default:         return undefined;
  }
};

const tagLabel = (type?: string): string => {
  switch (type) {
    case 'new':      return '新增';
    case 'updated':  return '更新';
    case 'archived': return '归档';
    default:         return '';
  }
};

function ArticlesList({ pages, statusMap, completedCount, totalCount, onHighlight, t }: ArticlesListProps) {
  const pageMap = useMemo(
    () => new Map(pages.map((p) => [p.slug, p])),
    [pages]
  );

  const selectItems = useMemo(
    () => pages.map((p) => ({ label: p.slug, value: p.slug })),
    [pages]
  );

  const indicatorComponent = useCallback(
    ({ isSelected }: { isSelected?: boolean }) => (
      <Text color={isSelected ? theme.primary : theme.muted}>
        {isSelected ? '>' : ' '}
      </Text>
    ),
    []
  );

  const itemComponent = useCallback(
    ({ isSelected, label }: { isSelected?: boolean; label: string }) => {
      const page = pageMap.get(label);
      if (!page) return null;

      const pg = statusMap[label];
      const status = pg?.status || 'waiting';
      const syncType = pg?.syncType ?? (page.status === 'unchanged' ? undefined : page.status);

      let statusText: string;
      if (status === 'loading' && pg?.phase === 'retry') {
        statusText = t('wikiGenerate.retrying', {
          n: pg.retryCount ?? 1,
          max: pg.maxRetries ?? 3,
          seconds: Math.ceil((pg.delayMs ?? 10000) / 1000),
        });
      } else if (status === 'loading' && pg?.phase === 'tool' && pg.currentTool) {
        const toolDisplay = pg.currentTool.replace(/_/g, ' ').replace(/^get /, '');
        statusText = t('wikiGenerate.tool', { name: toolDisplay });
      } else if (status === 'loading' && pg?.phase) {
        statusText = t(`wikiGenerate.${pg.phase}`);
      } else if (status === 'failed' && pg?.error) {
        statusText = pg.error;
      } else {
        statusText = t(`wikiGenerate.${status}`);
      }

      let rightText = `[${statusText}]`;
      if (status === 'loading' && pg?.usage) {
        if (pg.usage.input_tokens > 0)  rightText += ` ↑${formatBytes(pg.usage.input_tokens)}`;
        if (pg.usage.output_tokens > 0) rightText += ` ↓${formatBytes(pg.usage.output_tokens)}`;
      }
      if (status === 'completed') {
        if (pg?.durationMs !== undefined) rightText += ` ${formatDuration(pg.durationMs)}`;
        if (pg?.usage) {
          if (pg.usage.input_tokens > 0)  rightText += ` ↑${formatBytes(pg.usage.input_tokens)}`;
          if (pg.usage.output_tokens > 0) rightText += ` ↓${formatBytes(pg.usage.output_tokens)}`;
        }
      }

      const rightColor =
        status === 'loading'   ? (isSelected ? theme.primary : theme.warning) :
        status === 'completed' ? theme.success :
        status === 'failed'    ? theme.error   :
        theme.muted;

      const left = (
        <Box>
          <StatusIcon status={status} variant={isSelected ? 'active' : 'default'} />
          {syncType && (
            <Text color={tagColor(syncType)}>  [{tagLabel(syncType)}]</Text>
          )}
          <Text bold={isSelected}> {page.title}</Text>
        </Box>
      );

      return (
        <Box height={1}>
          <StatusRow left={left} right={<Text color={rightColor}>{rightText}</Text>} />
        </Box>
      );
    },
    [pageMap, statusMap, t]
  );

  const articlesTitle = t('wikiGenerate.articlesTitle', {
    current: completedCount,
    total: totalCount,
  });

  const handleHighlight = useCallback(
    (item: { value: string }) => onHighlight?.(item.value),
    [onHighlight]
  );

  return (
    <Box flexDirection="column">
      <Divider title={articlesTitle} />
      <Box marginTop={1}>
        <SelectInput
          items={selectItems}
          onHighlight={handleHighlight}
          indicatorComponent={indicatorComponent}
          itemComponent={itemComponent}
        />
      </Box>
    </Box>
  );
}
