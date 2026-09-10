/**
 * Wiki Command - 调用 App 启动 Wiki 文档生成
 */

import { runApp } from "../app";

export async function runWiki(): Promise<void> {
  runApp({ initialEntries: ["/wiki"] });
}
