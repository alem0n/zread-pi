/**
 * ANSI 样式工具 —— 对齐 Ink <Text> 的渲染语义
 *
 * 迁移前界面使用的 color / dimColor / bold 最终都是 ANSI SGR 序列，
 * 这里提供等价的最小实现，保证布局与配色肉眼一致。
 */

const RESET = "\x1b[0m";

/** Ink 支持的具名颜色（chalk 语义） */
const NAMED_COLORS: Record<string, number> = {
  black: 30,
  red: 31,
  green: 32,
  yellow: 33,
  blue: 34,
  magenta: 35,
  cyan: 36,
  white: 37,
  gray: 90,
  grey: 90,
  blackBright: 90,
  redBright: 91,
  greenBright: 92,
  yellowBright: 93,
  blueBright: 94,
  magentaBright: 95,
  cyanBright: 96,
  whiteBright: 97,
};

/** #0075de -> "38;2;0;117;222"；具名颜色 -> SGR 数字 */
export function colorCode(color: string): string {
  if (color.startsWith("#")) {
    let hex = color.slice(1);
    if (hex.length === 3) {
      hex = hex
        .split("")
        .map((char) => char + char)
        .join("");
    }
    const value = Number.parseInt(hex, 16);
    if (!Number.isFinite(value)) return "";
    return `38;2;${(value >> 16) & 255};${(value >> 8) & 255};${value & 255}`;
  }
  const code = NAMED_COLORS[color];
  return code === undefined ? "" : String(code);
}

export interface StyleOptions {
  bold?: boolean;
  dim?: boolean;
  inverse?: boolean;
  color?: string;
}

/** 用 SGR 序列包裹文本；无样式时原样返回 */
export function style(text: string, options: StyleOptions = {}): string {
  const codes: string[] = [];
  if (options.bold) codes.push("1");
  if (options.dim) codes.push("2");
  if (options.inverse) codes.push("7");
  if (options.color) {
    const code = colorCode(options.color);
    if (code) codes.push(code);
  }
  if (codes.length === 0) return text;
  return `\x1b[${codes.join(";")}m${text}${RESET}`;
}

export const bold = (text: string): string => style(text, { bold: true });
export const dim = (text: string): string => style(text, { dim: true });
export const inverse = (text: string): string => style(text, { inverse: true });
export const cyan = (text: string): string => style(text, { color: "cyan" });
export const gray = (text: string): string => style(text, { color: "gray" });
export const green = (text: string): string => style(text, { color: "green" });
export const yellow = (text: string): string => style(text, { color: "yellow" });
export const red = (text: string): string => style(text, { color: "red" });
export const white = (text: string): string => style(text, { color: "white" });
export const magenta = (text: string): string => style(text, { color: "magenta" });
export const blue = (text: string): string => style(text, { color: "blue" });
