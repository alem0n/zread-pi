/**
 * Logview Command - 启动轨迹（Trajectory）检查视图
 *
 * `zread-pi logview [runId]`：启动浏览服务器并在浏览器打开 `/trajectory/:runId`。
 * runId 缺省 / `latest` 时打开最新一次运行；没有运行记录时进入无运行态。
 */

import { runApp } from "../app";

export async function runLogview(runId?: string): Promise<void> {
  const entry = runId ? `/logview/${runId}` : "/logview";
  await runApp({ initialEntries: [entry] });
}
