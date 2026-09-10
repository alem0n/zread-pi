/**
 * Browse Command - 调用 App 启动 Wiki 文档浏览
 */

import { App } from '../App';

export async function runBrowse() {
  App({ initialEntries: ['/browse'] });
}