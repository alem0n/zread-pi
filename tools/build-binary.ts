/**
 * 构建 standalone 二进制（bun compile）并打包 zip。
 *
 * 布局约定（wasm 必须与二进制同目录，运行时按 process.execPath 同目录查找）：
 *   zread-pi[-vX.Y.Z-<os>-<arch>].zip
 *   ├── zread-pi(.exe)
 *   ├── tree-sitter.wasm
 *   ├── mappings.wasm
 *   └── browse/            # 「浏览文档」前端静态资源（可选，缺失时 browse 功能不可用）
 *
 * 前置条件（由 CI 或手动执行，本脚本只做「编译 + 组装 + 打 zip」）：
 *   bun install
 *   bun run vendor:build
 *   cd packages/types && bun run build && cd ../..   # 依次 types → utils → repo-analyzer → orchestrator
 *   bun run browse:build
 *   cd apps/cli && bun run build && cd ../..         # tsup 产物 dist/index.js + wasm + browse
 *
 * 用法：
 *   bun run tools/build-binary.ts [--target <target>]
 *   target ∈ windows-x64 | linux-x64 | linux-arm64 | macos-x64 | macos-arm64
 *   缺省 = 当前平台原生目标（bun compile 交叉编译到上述任意 target）。
 */
import { existsSync, mkdirSync, cpSync, rmSync, readFileSync, readdirSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const CLI_DIST = join(ROOT, 'apps', 'cli', 'dist');
const OUT_DIR = join(ROOT, 'dist-bin');

interface TargetInfo {
  /** bun build --compile 的 --target 值；native 编译时不传 */
  bunTarget?: string;
  os: string;
  arch: string;
  exeName: string;
}

const TARGETS: Record<string, TargetInfo> = {
  'windows-x64': { bunTarget: 'bun-windows-x64', os: 'windows', arch: 'x64', exeName: 'zread-pi.exe' },
  'linux-x64': { bunTarget: 'bun-linux-x64', os: 'linux', arch: 'x64', exeName: 'zread-pi' },
  'linux-arm64': { bunTarget: 'bun-linux-arm64', os: 'linux', arch: 'arm64', exeName: 'zread-pi' },
  'macos-x64': { bunTarget: 'bun-darwin-x64', os: 'macos', arch: 'x64', exeName: 'zread-pi' },
  'macos-arm64': { bunTarget: 'bun-darwin-arm64', os: 'macos', arch: 'arm64', exeName: 'zread-pi' },
};

function nativeTargetName(): string {
  const arch = process.arch === 'arm64' ? 'arm64' : 'x64';
  if (process.platform === 'win32') return `windows-${arch}`;
  if (process.platform === 'darwin') return `macos-${arch}`;
  return `linux-${arch}`;
}

function argValue(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

function fail(message: string): never {
  console.error(`[build-binary] ${message}`);
  process.exit(1);
}

/** 跨平台打 zip：优先 zip CLI（Linux CI），其次 bsdtar（Windows/macOS 自带），最后 PowerShell 兜底 */
function zipDir(stageDir: string, zipPath: string): void {
  if (spawnSync('zip', ['--version'], { stdio: 'ignore' }).status === 0) {
    const zip = spawnSync('zip', ['-r', '-X', '-q', zipPath, '.'], { cwd: stageDir, stdio: 'inherit' });
    if (zip.status !== 0) fail(`zip 失败（exit ${zip.status}）`);
    return;
  }

  // bsdtar（libarchive）支持写 zip：Windows 10+ 自带 tar.exe、macOS 默认 tar 均为 bsdtar。
  // Windows 上 PATH 里的 tar 可能是 GNU tar（如 Git Bash），优先用系统自带路径。
  const tarCandidates = process.platform === 'win32'
    ? ['C:/Windows/System32/tar.exe', 'tar']
    : ['tar'];
  for (const tarExe of tarCandidates) {
    const probe = spawnSync(tarExe, ['--version'], { encoding: 'utf-8' });
    if (probe.status !== 0) continue;
    if (!/bsdtar/i.test(probe.stdout ?? '')) continue;
    const tar = spawnSync(tarExe, ['--format', 'zip', '-cf', zipPath, '.'], { cwd: stageDir, stdio: 'inherit' });
    if (tar.status !== 0) fail(`bsdtar 打 zip 失败（exit ${tar.status}）`);
    return;
  }

  // 兜底：PowerShell Compress-Archive（路径含空格/引号已转义）
  const psExe = process.platform === 'win32' ? 'powershell.exe' : 'pwsh';
  const ps = spawnSync(
    psExe,
    [
      '-NoProfile', '-NonInteractive', '-Command',
      `Compress-Archive -Path (Join-Path '${stageDir.replace(/'/g, "''")}' '*') -DestinationPath '${zipPath.replace(/'/g, "''")}' -Force`,
    ],
    { stdio: 'inherit' },
  );
  if (ps.status !== 0) fail(`Compress-Archive 失败（exit ${ps.status}）`);
}

function main(): void {
  const targetName = argValue('--target') ?? nativeTargetName();
  const target = TARGETS[targetName];
  if (!target) {
    fail(`未知 target: ${targetName}（可选：${Object.keys(TARGETS).join(' | ')}）`);
  }

  const version = (JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf-8')) as { version: string }).version;
  const artifactName = `zread-pi-v${version}-${target.os}-${target.arch}`;
  const stageDir = join(OUT_DIR, artifactName);
  const zipPath = join(OUT_DIR, `${artifactName}.zip`);

  // 前置检查：tsup 产物必须已存在
  const bundleEntry = join(CLI_DIST, 'index.js');
  if (!existsSync(bundleEntry)) {
    fail(
      '未找到 apps/cli/dist/index.js。请先完成前置构建：\n'
      + '  bun run vendor:build\n'
      + '  cd packages/types && bun run build（依次 types/utils/repo-analyzer/orchestrator）\n'
      + '  bun run browse:build\n'
      + '  cd apps/cli && bun run build',
    );
  }

  // wasm 与二进制同目录（repo-analyzer 运行时按可执行文件同目录查找）
  for (const wasm of ['tree-sitter.wasm', 'mappings.wasm']) {
    if (!existsSync(join(CLI_DIST, wasm))) {
      fail(`未找到 apps/cli/dist/${wasm}；请重新执行 apps/cli 的 tsup 构建（onSuccess 会从 node_modules 复制）`);
    }
  }

  // 组装 stage 目录
  rmSync(stageDir, { recursive: true, force: true });
  mkdirSync(stageDir, { recursive: true });

  console.log(`[build-binary] 编译二进制：${targetName}${target.bunTarget ? `（--target ${target.bunTarget}）` : '（原生）'}`);
  const compileArgs = [
    'build', '--compile',
    ...(target.bunTarget ? ['--target', target.bunTarget] : []),
    bundleEntry,
    '--outfile', join(stageDir, target.exeName),
  ];
  const compiled = spawnSync(process.execPath, compileArgs, { stdio: 'inherit', cwd: ROOT });
  if (compiled.status !== 0) fail(`bun compile 失败（exit ${compiled.status}）`);

  for (const wasm of ['tree-sitter.wasm', 'mappings.wasm']) {
    cpSync(join(CLI_DIST, wasm), join(stageDir, wasm));
  }

  const browseSrc = join(CLI_DIST, 'browse');
  if (existsSync(join(browseSrc, 'index.html'))) {
    cpSync(browseSrc, join(stageDir, 'browse'), { recursive: true });
  } else {
    console.warn('[build-binary] 未找到 dist/browse（前端未构建），zip 将不含「浏览文档」静态资源');
  }

  // 打 zip
  rmSync(zipPath, { force: true });
  zipDir(stageDir, zipPath);

  const files = readdirSync(stageDir);
  console.log(`[build-binary] 完成: ${zipPath}`);
  console.log(`[build-binary] 内容: ${files.join(', ')}${existsSync(join(stageDir, 'browse')) ? ', browse/' : ''}`);
}

main();
