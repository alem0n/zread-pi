/**
 * Select - 选择列表组件（对齐 ink-select-input 的行为 + 可用性补强）
 *
 * 按键：
 * - ↑ / k：上移（到顶后回绕到底部）
 * - ↓ / j：下移（到底后回绕到顶部）
 * - PageUp / PageDown：整页上下移动
 * - Home / End：跳到首项 / 末项
 * - Enter：确认选中
 *
 * 列表项值发生变化时，选中项重置为第一项。
 * 每一项由调用方通过 renderItem 渲染（可能是多行，例如配置首页）。
 *
 * 分页：调用方用 setViewportRows() 告知可用行数（页面高度 - 列表外的行数）。
 * 超出可视区域时按「跟随选中项的最小滚动」取窗口，并在末尾追加 `(n/总数)` 位置指示，
 * 保证选中项永远可见 —— 迁移前 ink-select-input 会把整张表铺开、超出屏幕的部分不可见也不可导航。
 */

import { matchesKey, type Component } from "@earendil-works/pi-tui";
import { style } from "../ansi";
import { clampLine, padRight } from "../text-layout";

export interface SelectOption {
  value: string;
}

export interface SelectConfig<T extends SelectOption> {
  items: T[];
  /**
   * 固定可见项数（与迁移前的 VirtualSelect 语义一致）。
   * 一般改用 setViewportRows() 按行窗口化，二者同时设置时以行数为准。
   */
  viewportSize?: number;
  /** 渲染列表项，返回一行或多行 */
  renderItem: (item: T, isSelected: boolean, width: number) => string[];
  onSelect?: (item: T) => void;
  onHighlight?: (item: T) => void;
  /** 初始选中下标 */
  initialIndex?: number;
}

export class Select<T extends SelectOption> implements Component {
  protected items: T[];
  private selectedIndex: number;
  private viewportSize?: number;
  /** 可用行数（含位置指示行）；undefined 表示不限制 */
  private viewportRows?: number;
  private renderItemFn: (item: T, isSelected: boolean, width: number) => string[];
  private lastValues: string[] = [];
  /** 最近一次渲染的窗口（PageUp/PageDown 的翻页步长） */
  private lastWindow = { start: 0, end: 0 };

  onSelect?: (item: T) => void;
  onHighlight?: (item: T) => void;

  constructor(config: SelectConfig<T>) {
    this.items = config.items;
    this.viewportSize = config.viewportSize;
    this.renderItemFn = config.renderItem;
    this.onSelect = config.onSelect;
    this.onHighlight = config.onHighlight;
    this.selectedIndex = this.clampIndex(config.initialIndex ?? 0);
    this.lastValues = this.items.map((item) => item.value);
  }

  /** 更新列表数据（值变化时重置选中项，与 ink-select-input 的 useEffect 等价） */
  setItems(items: T[]): void {
    this.items = items;
    const values = items.map((item) => item.value);
    const changed =
      values.length !== this.lastValues.length ||
      values.some((value, index) => value !== this.lastValues[index]);
    this.lastValues = values;
    if (changed) {
      this.selectedIndex = 0;
    } else {
      this.selectedIndex = Math.min(this.selectedIndex, Math.max(0, items.length - 1));
    }
  }

  /** 设置可用行数（页面高度减去列表之外的行数）；不设置则不窗口化 */
  setViewportRows(rows?: number): void {
    this.viewportRows = rows === undefined ? undefined : Math.max(1, Math.floor(rows));
  }

  getSelectedIndex(): number {
    return this.selectedIndex;
  }

  setSelectedIndex(index: number): void {
    this.selectedIndex = this.clampIndex(index);
  }

  getSelectedItem(): T | undefined {
    return this.items[this.selectedIndex];
  }

  invalidate(): void {
    // 无缓存状态
  }

  render(width: number): string[] {
    if (this.items.length === 0) return [];

    // 一次性渲染所有项（项内容依赖实时状态，跨帧不缓存），再按行窗口切片
    const rendered = this.items.map((item, index) =>
      this.renderItemFn(item, index === this.selectedIndex, width),
    );
    const heights = rendered.map((lines) => lines.length);

    const window = this.computeWindow(heights);
    this.lastWindow = window;

    const lines: string[] = [];
    for (let index = window.start; index < window.end; index++) {
      for (const line of rendered[index] ?? []) {
        lines.push(padRight(clampLine(line, width), width));
      }
    }

    // 超出可视区域时给出位置指示（与迁移前 VirtualSelect 的 `(n/总数)` 一致）
    const indicator = scrollIndicator(this.selectedIndex, this.items.length, window.start, window.end);
    if (indicator) {
      lines.push(padRight(style(indicator, { dim: true }), width));
    }

    return lines;
  }

  /** 处理按键；返回 true 表示已消费（ESC 不在此处理） */
  handleInput(data: string): boolean {
    if (this.items.length === 0) return false;

    if (matchesKey(data, "up") || data === "k") {
      this.selectedIndex =
        this.selectedIndex === 0 ? this.items.length - 1 : this.selectedIndex - 1;
      this.notifyChange();
      return true;
    }
    if (matchesKey(data, "down") || data === "j") {
      this.selectedIndex =
        this.selectedIndex === this.items.length - 1 ? 0 : this.selectedIndex + 1;
      this.notifyChange();
      return true;
    }
    if (matchesKey(data, "pageUp")) {
      this.moveBy(-this.pageStep());
      return true;
    }
    if (matchesKey(data, "pageDown")) {
      this.moveBy(this.pageStep());
      return true;
    }
    if (matchesKey(data, "home")) {
      if (this.selectedIndex !== 0) {
        this.selectedIndex = 0;
        this.notifyChange();
      }
      return true;
    }
    if (matchesKey(data, "end")) {
      const last = this.items.length - 1;
      if (this.selectedIndex !== last) {
        this.selectedIndex = last;
        this.notifyChange();
      }
      return true;
    }
    if (matchesKey(data, "return")) {
      const selected = this.items[this.selectedIndex];
      if (selected && this.onSelect) this.onSelect(selected);
      return true;
    }
    return false;
  }

  private moveBy(delta: number): void {
    const next = this.clampIndex(this.selectedIndex + delta);
    if (next === this.selectedIndex) return;
    this.selectedIndex = next;
    this.notifyChange();
  }

  /** 翻页步长：上一个窗口的可见项数（至少 1） */
  private pageStep(): number {
    const visible = this.lastWindow.end - this.lastWindow.start;
    return visible > 0 ? visible : 10;
  }

  private notifyChange(): void {
    const selected = this.items[this.selectedIndex];
    if (selected && this.onHighlight) this.onHighlight(selected);
  }

  private clampIndex(index: number): number {
    if (this.items.length === 0) return 0;
    return Math.max(0, Math.min(index, this.items.length - 1));
  }

  /**
   * 计算可见窗口
   * - 未设置行数限制：渲染全部
   * - 设置了固定项数（viewportSize）：沿用迁移前 VirtualSelect 的居中窗口
   * - 设置了行数：以选中项为中心向两侧扩展（尽量居中），保证选中项始终可见
   */
  private computeWindow(heights: number[]): { start: number; end: number } {
    const total = heights.reduce((sum, height) => sum + height, 0);

    if (this.viewportRows === undefined && this.viewportSize === undefined) {
      return { start: 0, end: this.items.length };
    }

    if (this.viewportRows === undefined) {
      const budget = this.viewportSize!;
      const start = Math.max(
        0,
        Math.min(
          this.selectedIndex - Math.floor(budget / 2),
          Math.max(0, this.items.length - budget),
        ),
      );
      return { start, end: Math.min(start + budget, this.items.length) };
    }

    return computeItemWindow(heights, this.selectedIndex, this.viewportRows ?? total);
  }
}

/**
 * 分页窗口计算（供自行渲染列表的页面复用）
 *
 * 以选中项为中心向上下交替扩展，直到行数预算用尽，保证选中项一定在窗口内。
 * 内容超过预算时会预留 1 行为位置指示（scrollIndicator），因此返回的窗口最多占 budget - 1 行。
 * @param heights 每项占用的行数
 * @param selectedIndex 当前选中下标
 * @param budget 可用行数（>= 1，含可能出现的位置指示行）
 */
export function computeItemWindow(
  heights: number[],
  selectedIndex: number,
  budget: number,
): { start: number; end: number } {
  const count = heights.length;
  if (count === 0) return { start: 0, end: 0 };

  const rowsAvailable = Math.max(1, Math.floor(budget));
  const totalRows = heights.reduce((sum, height) => sum + height, 0);
  // 放不下时末尾会追加一行 `(n/总数)`，提前扣掉
  const maxRows = totalRows <= rowsAvailable ? rowsAvailable : Math.max(1, rowsAvailable - 1);

  const index = Math.max(0, Math.min(selectedIndex, count - 1));

  let start = index;
  let end = index + 1;
  let rows = heights[index] ?? 1;
  let preferAbove = true;

  while (true) {
    const canAbove = start > 0 && rows + (heights[start - 1] ?? 0) <= maxRows;
    const canBelow = end < count && rows + (heights[end] ?? 0) <= maxRows;
    if (!canAbove && !canBelow) break;

    if (preferAbove && canAbove) {
      start -= 1;
      rows += heights[start] ?? 0;
    } else if (canBelow) {
      rows += heights[end] ?? 0;
      end += 1;
    } else {
      start -= 1;
      rows += heights[start] ?? 0;
    }
    preferAbove = !preferAbove;
  }

  return { start, end };
}

/** 超出可视区域时的位置指示（`(n/总数)`，上下还有隐藏项时补箭头） */
export function scrollIndicator(
  selectedIndex: number,
  total: number,
  start: number,
  end: number,
): string | undefined {
  if (start <= 0 && end >= total) return undefined;
  const prefix = start > 0 ? "↑ " : "";
  const suffix = end < total ? " ↓" : "";
  return `${prefix}(${selectedIndex + 1}/${total})${suffix}`;
}

/** ink-select-input 默认行：选中蓝色 ❯ + 蓝色文本 */
export function defaultRow(label: string, isSelected: boolean): string {
  const indicator = isSelected ? style("❯", { color: "blue" }) : " ";
  const text = isSelected ? style(label, { color: "blue" }) : label;
  return indicator + " " + text;
}

/** 列表行左侧指示条（原各个页面自定义的 `│ ` / `  `，选中青色） */
export function barIndicator(isSelected: boolean): string {
  return isSelected ? style("│ ", { color: "cyan" }) : style("  ", { color: "gray" });
}
