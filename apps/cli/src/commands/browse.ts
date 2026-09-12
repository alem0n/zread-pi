/**
 * Browse Command - 调用 App 启动 Wiki 文档浏览
 */

import { runApp } from "../app";

export async function runBrowse(): Promise<void> {
  await runApp({ initialEntries: ["/browse"] });
}
