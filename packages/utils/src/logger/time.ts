/**
 * Time 工具的最小子集 —— 移植自 cosmokit 的 `vendor/cosmokit/src/time.ts`。
 *
 * 只保留日志要用到的三个能力：`template`（本地时间格式化模板）、
 * `format`（毫秒差值的人类可读格式）、`toDigits`（补零）。
 * 其余（parseTime / parseDate / getTimezoneOffset / 星期换算等）日志用不到，不引入。
 *
 * 跨平台：全部使用 `Date` 的本地时区方法（getHours 等），不硬编码时区。
 */

/** Time constants plus formatting helpers. */
export namespace Time {
  const millisecond = 1;
  const second = 1000;
  const minute = second * 60;
  const hour = minute * 60;
  const day = hour * 24;

  /** 把毫秒差值格式化为 `1d` / `2h` / `3m` / `4s` / `567ms`。 */
  export function format(ms: number): string {
    const abs = Math.abs(ms);
    if (abs >= day - hour / 2) {
      return Math.round(ms / day) + 'd';
    } else if (abs >= hour - minute / 2) {
      return Math.round(ms / hour) + 'h';
    } else if (abs >= minute - second / 2) {
      return Math.round(ms / minute) + 'm';
    } else if (abs >= second) {
      return Math.round(ms / second) + 's';
    }
    return ms + 'ms';
  }

  /** 数字按指定位数补零：`toDigits(3, 2)` → `'03'`。 */
  export function toDigits(source: number, length = 2): string {
    return source.toString().padStart(length, '0');
  }

  /**
   * 本地时间模板替换：`yyyy` `yy` `MM` `dd` `hh` `mm` `ss` `SSS`。
   *
   * 与 cosmokit 逐字一致（按此顺序 replace，每个占位符只替换首次出现）。
   */
  export function template(template: string, time = new Date()): string {
    return template
      .replace('yyyy', time.getFullYear().toString())
      .replace('yy', time.getFullYear().toString().slice(2))
      .replace('MM', toDigits(time.getMonth() + 1))
      .replace('dd', toDigits(time.getDate()))
      .replace('hh', toDigits(time.getHours()))
      .replace('mm', toDigits(time.getMinutes()))
      .replace('ss', toDigits(time.getSeconds()))
      .replace('SSS', toDigits(time.getMilliseconds(), 3));
  }
}
