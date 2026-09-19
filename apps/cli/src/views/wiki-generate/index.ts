/**
 * Wiki Generate Page - Wiki 文档生成（pi-tui 版）
 *
 * URL 参数：
 * - mode=generate: 新生成（wiki.json 不存在）
 * - mode=continue: 继续生成（wiki.json 存在，文档未完成）
 * - mode=manage: 管理文档（wiki.json 存在，文档已完成，可重新生成单个）
 * - mode=force: 强制重新生成（忽略现有 wiki.json）
 *
 * 按键：↑↓ 导航 | r 重新生成（目录失败时重试目录） | ctrl+c 退出
 */

import { Divider } from "../../tui/components/divider";
import { Select } from "../../tui/components/select";
import { SPINNER_FRAMES, SPINNER_INTERVAL_MS, statusIcon, statusRow } from "../../tui/components/status";
import { style } from "../../tui/ansi";
import { Screen } from "../../tui/screen";
import { theme } from "../../theme";
import { formatBytes, formatDuration } from "../../utils/display";
import { WikiGenerateController } from "./controller";
import {
  cacheHitRatio,
  collectUsageTotals,
  contextUsage,
  formatPercent,
  slotUsageTotal,
  toUsageTotals,
} from "./usage";
import type { CatalogAgentState, PageStatus, TokenUsage, WikiPage } from "./types";

type ArticleItem = { value: string; page: WikiPage };

export default class WikiGeneratePage extends Screen {
  private controller!: WikiGenerateController;
  private select!: Select<ArticleItem>;
  private selectedSlug: string | null = null;
  private ticker?: ReturnType<typeof setInterval>;
  /** spinner 动画帧（loading 图标轮换用） */
  private spinnerFrame = 0;
  /** 每个 slug 进入 retry 阶段的时间戳（用于倒计时） */
  private retryStartedAt = new Map<string, number>();

  protected override init(): void {
    const mode = this.app.location?.query.get("mode");

    this.controller = new WikiGenerateController({
      forceRegenerate: mode === "force",
      wiki: this.app.wiki,
      onChange: () => {
        this.syncRetryStates();
        this.refresh();
      },
    });

    this.select = new Select<ArticleItem>({
      items: [],
      renderItem: (item, isSelected, width) => [
        this.renderArticleRow(item.page, isSelected, width),
      ],
      onHighlight: (item) => {
        this.selectedSlug = item.page.slug;
      },
    });

    // 重试倒计时需要每秒刷新；loading 图标动画需要每帧刷新
    this.ticker = setInterval(() => {
      const hasRetrying = this.syncRetryStates();
      if (this.hasLoadingItem()) {
        this.spinnerFrame = (this.spinnerFrame + 1) % SPINNER_FRAMES.length;
        this.refresh();
      } else if (hasRetrying) {
        this.refresh();
      }
    }, SPINNER_INTERVAL_MS);
  }

  override async onEnter(): Promise<void> {
    // 直接进入该路由时（未经 wiki 首页）也要先加载 wiki.json，再决定是否生成目录
    await this.app.wiki.load();
    this.controller.init();
  }

  override handleKey(data: string): boolean {
    // l：查看最近一次运行的轨迹（目录 + 页面阶段共享的 run）
    if (data === "l" && this.controller.lastRunId) {
      this.app.navigate(`/logview/${this.controller.lastRunId}`);
      return true;
    }

    // 目录失败时按 r 重新生成目录
    if (data === "r" && this.controller.state.catalog.status === "failed") {
      this.controller.retryCatalog();
      return true;
    }

    // 选中文章时按 r 重新生成该文章
    if (data === "r" && this.selectedSlug) {
      void this.controller.regeneratePage(this.selectedSlug);
      return true;
    }

    return this.select.handleInput(data);
  }

  override onDestroy(): void {
    if (this.ticker) clearInterval(this.ticker);
  }

  render(width: number): string[] {
    const lines: string[] = [];

    // 目录生成部分
    lines.push(...this.renderCatalogSection(width));

    // 底部导航（marginTop={1}）+ 用量合计（有数据时才是最后一行）
    const footer = [
      "",
      style(
        `↑/↓: ${this.t("wikiGenerate.navigate")} | r: ${this.t("wikiGenerate.retry")} | ctrl+c: ${this.t("wikiGenerate.exit")}` +
          (this.controller.lastRunId
            ? ` | l: ${this.t("wikiGenerate.viewTrajectory")}`
            : ""),
        { dim: true },
      ),
    ];
    const usageTotals = this.renderUsageTotals();
    if (usageTotals) footer.push(usageTotals);

    // 文章生成部分（目录完成后显示）
    lines.push(...this.renderArticlesSection(width, lines.length, footer.length));

    return [...lines, ...footer];
  }

  /**
   * 底部合计行：全部 Agent（目录 + 每个页面）的输入 / 输出 token 与缓存占比。
   *
   * 用量为 0（尚未开始或打开的文档已全部存在）时返回 null，不占屏幕行。
   * 并发正确性见 ./usage.ts 的模块注释：每页各自的累计快照做幂等 reduce。
   */
  private renderUsageTotals(): string | null {
    const { catalog, articles } = this.controller.state;
    const totals = collectUsageTotals(catalog, articles);
    if (totals.total <= 0) return null;

    return style(
      this.t("wikiGenerate.usageTotals", {
        input: formatBytes(totals.totalInput),
        output: formatBytes(totals.output),
        ratio: formatPercent(cacheHitRatio(totals)),
      }),
      { dim: true },
    );
  }

  // ==================== 目录段 ====================

  private renderCatalogSection(width: number): string[] {
    const state = this.controller.state.catalog;
    const { status, phase, currentTool, durationMs, error, retryCount, maxRetries, delayMs } = state;
    const { stage, sectionsProgress, section, failedSections } = state;
    // 展示口径 = 历史结转 + 本轮快照（重试不清零）
    const usage = slotUsageTotal(state);

    // 构建状态文字
    let statusText: string;
    if (status === "loading" && phase === "retry") {
      // 重试状态：显示次数和延迟
      const seconds = Math.ceil((delayMs || 10000) / 1000);
      statusText = this.t("wikiGenerate.retrying", {
        n: retryCount ?? 1,
        max: maxRetries ?? 3,
        seconds,
      });
    } else if (status === "loading" && stage) {
      // 三阶段：分类 → 分主题 → 标题（带分类级进度）
      statusText = this.stageStatusText(stage, sectionsProgress, section);
    } else if (status === "loading" && phase === "tool" && currentTool) {
      // 工具调用
      const toolDisplay = currentTool.replace(/_/g, " ").replace(/^get /, "");
      statusText = this.t("wikiGenerate.tool", { name: toolDisplay });
    } else if (status === "loading") {
      // requesting/responding/scanning/解析 → 统一显示请求中
      statusText = this.t("wikiGenerate.requesting");
    } else if (status === "failed" && error) {
      statusText = error;
    } else if (status === "completed" && failedSections && failedSections.length > 0) {
      statusText =
        this.t("wikiGenerate.completed") +
        " · " +
        this.t("wikiGenerate.failedSections", { n: failedSections.length });
    } else {
      statusText = this.t(`wikiGenerate.${status}`);
    }

    // 右栏：状态 + 用量指标（输入 / 输出 / 缓存占比 / 耗时；完成、失败也照常显示）
    const rightText = `[${statusText}]` + this.usageSuffix({ usage, durationMs });

    const rightColor =
      status === "loading"
        ? theme.warning
        : status === "completed"
          ? theme.success
          : status === "failed"
            ? theme.error
            : theme.muted;

    // 左栏：图标 + 标题（loading 时图标轮换）
    const left =
      statusIcon(status, "default", this.spinnerFrame) +
      " " +
      this.t("wikiGenerate.catalogTitle");

    return [
      ...new Divider(this.t("wikiGenerate.catalogTitle")).render(width),
      statusRow(width, left, style(rightText, { color: rightColor })),
      // 目录生成会并发跑多个 Agent：分类 / 每个分类的主题、标题 / 缩编 subagent，
      // 每个 Agent 一行（其中一行的用量不是目录级聚合，是该 Agent 自己的快照）
      ...this.renderAgentRows(width),
    ];
  }

  /** 目录 Agent 行：每个 Agent 一行（按规划顺序，记录 key 的插入顺序即展示顺序） */
  private renderAgentRows(width: number): string[] {
    const agents = this.controller.state.catalog.agents;
    if (!agents) return [];
    return Object.entries(agents).map(([key, agent]) => this.renderAgentRow(width, key, agent));
  }

  /** 单个目录 Agent 行：缩进 + 图标 + 角色标签 / 状态 + 四个用量指标 */
  private renderAgentRow(width: number, key: string, agent: CatalogAgentState): string {
    const rightText =
      `[${this.agentStatusText(key, agent)}]` +
      this.usageSuffix({
        usage: agent.usage,
        contextTokens: agent.contextTokens,
        contextWindow: agent.contextWindow,
        durationMs: agent.durationMs,
      });

    const rightColor =
      agent.status === "loading"
        ? theme.warning
        : agent.status === "completed"
          ? theme.success
          : agent.status === "failed"
            ? theme.error
            : theme.muted;

    const left =
      "  " +
      statusIcon(agent.status, "default", this.spinnerFrame) +
      " " +
      style(this.agentLabel(agent), { dim: true });

    return statusRow(width, left, style(rightText, { color: rightColor }));
  }

  /** Agent 标签（名称描述该 Agent 此刻在做什么：规划主题 / 拟定标题 / 精修标题 / 精简清单） */
  private agentLabel(agent: CatalogAgentState): string {
    switch (agent.role) {
      case "topics":
        return this.t("wikiGenerate.agentTopics", { section: agent.section ?? "" });
      case "titles":
        return this.t("wikiGenerate.agentTitles", { section: agent.section ?? "" });
      case "condense":
        // 缩编 subagent 精简的是它所在阶段的清单：分类阶段是主题清单，其余是标题清单
        return agent.stage === "classify"
          ? this.t("wikiGenerate.agentCondenseSections")
          : this.t("wikiGenerate.agentCondenseTopics", { section: agent.section ?? "" });
      default:
        return this.t("wikiGenerate.agentClassify");
    }
  }

  /** Agent 行的状态文字（等待 / 请求中 / 工具 / 重试倒计时 / 完成 / 失败） */
  private agentStatusText(key: string, agent: CatalogAgentState): string {
    if (agent.status === "loading" && agent.phase === "retry") {
      const seconds = this.retrySeconds(this.agentRetryKey(key), agent.delayMs ?? 10000);
      return this.t("wikiGenerate.retrying", {
        n: agent.retryCount ?? 1,
        max: agent.maxRetries ?? 3,
        seconds,
      });
    }
    if (agent.status === "loading" && agent.phase === "tool" && agent.currentTool) {
      const toolDisplay = agent.currentTool.replace(/_/g, " ").replace(/^get /, "");
      return this.t("wikiGenerate.tool", { name: toolDisplay });
    }
    if (agent.status === "loading" && agent.phase) {
      return this.t(`wikiGenerate.${agent.phase}`);
    }
    if (agent.status === "loading") {
      // 已规划未开始 / 运行开始的瞬间：统一显示请求中
      return this.t("wikiGenerate.requesting");
    }
    if (agent.status === "failed" && agent.error) {
      return agent.error.split("\n")[0].slice(0, 60);
    }
    return this.t(`wikiGenerate.${agent.status}`);
  }

  /**
   * 行内用量后缀（右侧状态后追加的指标串）：
   * 输入侧总量 / 输出 / 缓存占比 / 上下文（已用 / 窗口 + 占比）/ 耗时。
   * 任一指标无数据时自动省略（不做零值占位）。
   */
  private usageSuffix(input: {
    usage?: TokenUsage;
    contextTokens?: number;
    contextWindow?: number;
    durationMs?: number;
  }): string {
    const parts: string[] = [];

    if (input.usage) {
      const totals = toUsageTotals(input.usage);
      const tokenParts: string[] = [];
      if (totals.totalInput > 0) tokenParts.push(`↑${formatBytes(totals.totalInput)}`);
      if (totals.output > 0) tokenParts.push(`↓${formatBytes(totals.output)}`);
      if (tokenParts.length > 0) parts.push(tokenParts.join(" "));
      if (totals.totalInput > 0) {
        parts.push(this.t("wikiGenerate.metricsCache", { ratio: formatPercent(cacheHitRatio(totals)) }));
      }
    }

    const context = contextUsage(input.contextTokens, input.contextWindow);
    if (context) {
      parts.push(
        this.t("wikiGenerate.metricsContext", {
          used: formatBytes(context.used),
          window: formatBytes(context.window),
          ratio: formatPercent(context.ratio),
        }),
      );
    }

    if (input.durationMs !== undefined) parts.push(formatDuration(input.durationMs));

    return parts.length > 0 ? ` ${parts.join(" · ")}` : "";
  }

  /** 三阶段状态文字（classify / topics / titles；带分类级进度） */
  private stageStatusText(
    stage: "classify" | "topics" | "titles",
    progress?: { current: number; total: number },
    section?: string,
  ): string {
    if (stage === "classify") return this.t("wikiGenerate.stageClassify");

    const suffix = section ? this.t("wikiGenerate.stageSection", { section }) : "";
    const hasProgress = progress !== undefined && progress.total > 0;

    if (stage === "topics") {
      return hasProgress
        ? this.t("wikiGenerate.stageTopics", { current: progress.current, total: progress.total }) + suffix
        : this.t("wikiGenerate.stageTopicsIdle");
    }

    return hasProgress
      ? this.t("wikiGenerate.stageTitles", { current: progress.current, total: progress.total }) + suffix
      : this.t("wikiGenerate.stageTitlesIdle");
  }

  // ==================== 文章段 ====================

  private renderArticlesSection(width: number, preLines: number, postLines: number): string[] {
    const { state } = this.controller;
    if (!this.controller.catalogCompleted || state.wikiPages.length === 0) return [];

    const pages = state.wikiPages;
    const statusMap = state.articles.pages;

    // 统计完成数量
    const completedCount = pages.filter(
      (p) => statusMap[p.slug]?.status === "completed",
    ).length;
    const articlesTitle = this.t("wikiGenerate.articlesTitle", {
      current: completedCount,
      total: pages.length,
    });

    this.select.setItems(pages.map((page) => ({ value: page.slug, page })));
    // 分页：只有列表内的行数受可用高度约束
    this.select.setViewportRows(
      Math.max(3, this.app.availableRows - preLines - postLines - 3),
    );

    return [
      ...new Divider(articlesTitle).render(width),
      // <Box marginTop={1}>
      "",
      ...this.select.render(width),
    ];
  }

  private renderArticleRow(page: WikiPage, isSelected: boolean, width: number): string {
    const statusMap = this.controller.state.articles.pages;
    const pageState = statusMap[page.slug];
    const status = pageState?.status || "waiting";
    const phase = pageState?.phase;
    const currentTool = pageState?.currentTool;
    // 展示口径 = 历史结转 + 本轮快照：重新生成时已消耗的 token 留在槽位里（不清零）
    const usage = pageState ? slotUsageTotal(pageState) : undefined;

    // 重试状态：实时倒计时
    const isRetrying = status === "loading" && phase === "retry";
    const delayMs = pageState?.delayMs || 10000;
    const retryCount = pageState?.retryCount ?? 1;
    const maxRetries = pageState?.maxRetries ?? 3;

    // 状态文字：根据 phase 显示详细状态
    let statusText: string;
    if (isRetrying) {
      // 重试状态：倒计时显示（由下方 CountdownRow 逻辑处理）
      statusText = "";
    } else if (status === "loading" && phase === "tool" && currentTool) {
      const toolDisplay = currentTool.replace(/_/g, " ").replace(/^get /, "");
      statusText = this.t("wikiGenerate.tool", { name: toolDisplay });
    } else if (status === "loading" && phase) {
      statusText = this.t(`wikiGenerate.${phase}`);
    } else if (status === "failed" && pageState?.error) {
      statusText = pageState.error;
    } else {
      statusText = this.t(`wikiGenerate.${status}`);
    }

    const rightColor =
      status === "loading"
        ? isSelected
          ? theme.primary
          : theme.warning
        : status === "completed"
          ? theme.success
          : status === "failed"
            ? theme.error
            : theme.muted;

    // 左栏：指示器 + 图标 + 标题
    const indicator = isSelected
      ? style(">", { color: theme.primary })
      : style(" ", { color: theme.muted });
    const left =
      indicator +
      statusIcon(status, isSelected ? "active" : "default", this.spinnerFrame) +
      style(" " + page.title, { bold: isSelected });

    // 右栏指标（输入 / 输出 / 缓存占比 / 上下文占比 / 耗时）
    // 口径：用量 = 历史结转 + 本轮快照；上下文 = 最近一次响应（与累计用量不同）。
    // 完成 / 失败也照常显示（要求：即便已完成也在 [完成] 右侧显示）。
    const suffix = this.usageSuffix({
      usage,
      contextTokens: pageState?.contextTokens,
      contextWindow: pageState?.contextWindow,
      durationMs: pageState?.durationMs,
    });

    // 内容门标记：页面已完成但低于密度下限（warn 只报告；enforce-degraded 已降级落盘）
    const gateMarker = this.gateMarker(pageState?.gate);

    // 重试状态使用特殊逻辑（带倒计时）
    if (isRetrying) {
      const seconds = this.retrySeconds(page.slug, delayMs);
      const countdownText =
        `[${this.t("wikiGenerate.retrying", {
          n: retryCount,
          max: maxRetries,
          seconds,
        })}]` + suffix;
      return statusRow(width, left, style(countdownText, { color: rightColor }));
    }

    // 普通状态（内容门标记以黄色追加，不改变成功/失败的颜色语义）
    const rightText = `[${statusText}]` + suffix + (gateMarker ? ` ${gateMarker}` : "");

    return statusRow(width, left, style(rightText, { color: rightColor }));
  }

  /** 内容门标记：未达标时返回黄色提示串（warn 只报告 / enforce-degraded 降级落盘） */
  private gateMarker(gate: PageStatus["gate"]): string | null {
    if (!gate || gate.passed) return null;
    const label =
      gate.mode === "enforce-degraded"
        ? this.t("wikiGenerate.gateDegraded")
        : this.t("wikiGenerate.gateWarn");
    return style(`⚠ ${label}`, { color: theme.warning });
  }

  /** 计算 retry 剩余秒数（等价迁移前的 useCountdown） */
  private retrySeconds(slug: string, delayMs: number): number {
    const startedAt = this.retryStartedAt.get(slug);
    if (startedAt === undefined) return Math.ceil(delayMs / 1000);
    return Math.max(0, Math.ceil((delayMs - (Date.now() - startedAt)) / 1000));
  }

  /** 目录 Agent 的倒计时 key（与页面 slug 共用一张表，前缀避免重名） */
  private agentRetryKey(key: string): string {
    return `agent:${key}`;
  }

  /** 目录或任一文章是否处于 loading 状态（决定 spinner 是否需要转动） */
  private hasLoadingItem(): boolean {
    if (this.controller.state.catalog.status === "loading") return true;
    const statusMap = this.controller.state.articles.pages;
    return this.controller.state.wikiPages.some(
      (page) => statusMap[page.slug]?.status === "loading",
    );
  }

  /** 同步 retry 状态的倒计时起点（页面 + 目录 Agent）；返回是否仍有条目在重试 */
  private syncRetryStates(): boolean {
    const statusMap = this.controller.state.articles.pages;
    let anyRetrying = false;
    for (const page of this.controller.state.wikiPages) {
      const pageState = statusMap[page.slug];
      if (pageState?.status === "loading" && pageState.phase === "retry") {
        // 记录倒计时起点（仅第一次进入 retry 时）
        if (!this.retryStartedAt.has(page.slug)) {
          this.retryStartedAt.set(page.slug, Date.now());
        }
        anyRetrying = true;
      } else {
        this.retryStartedAt.delete(page.slug);
      }
    }

    // 目录 Agent 行（分类 / 主题 / 标题 / 缩编）也要倒计时
    const agents = this.controller.state.catalog.agents ?? {};
    for (const [key, agent] of Object.entries(agents)) {
      const mapKey = this.agentRetryKey(key);
      if (agent.status === "loading" && agent.phase === "retry") {
        if (!this.retryStartedAt.has(mapKey)) {
          this.retryStartedAt.set(mapKey, Date.now());
        }
        anyRetrying = true;
      } else {
        this.retryStartedAt.delete(mapKey);
      }
    }

    return anyRetrying;
  }
}
