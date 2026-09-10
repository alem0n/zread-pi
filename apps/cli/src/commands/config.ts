/**
 * Config Command - 调用 App 启动配置编辑器
 */

import { runApp } from "../app";

export async function runConfig(): Promise<void> {
  runApp({ initialEntries: ["/config"] });
}
