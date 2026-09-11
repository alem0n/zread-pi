/**
 * tools-smoke.ts —— 工具层专项回归（离线，无需 API Key）
 *
 * 覆盖 AGENTS.md「工具层改造」的每一项改动，并对每条搜索路径同时跑
 * 「系统二进制（rg/fd）」与「纯 JS 兜底」两种实现，断言两者结果一致：
 *
 *  1. 共享设施：truncate（行/字节上限、长行截断、notices 拼装）
 *  2. glob 语义：与 fd `--glob` 对齐（无 `/` 匹配 basename、`**` `/` 补全、花括号、字符类）
 *  3. Ls    ：排序、目录后缀、dotfile、条目上限、字节截断、错误文案
 *  4. Glob  ：相对路径输出、.gitignore、node_modules 排除、上限提示、两条路径一致
 *  5. Grep  ：content / files_with_matches / count、glob 过滤、大小写、字面量、上下文、
 *             上限、非法正则、.gitignore、两条路径一致
 *  5b. git 仓库内的 .gitignore 分支：两种搜索路径都要与 fd/rg 的 git-aware 默认行为一致
 *  6. Read  ：offset 1-based、limit 续读提示、截断提示、目录报错点名 Ls、
 *             magic number 图片识别（支持/不支持图片的模型）、二进制与空文件
 *  7. Write ：建目录、created 标记、同文件并发写不丢更新
 *  8. Edit  ：CRLF/BOM 归一化、多段 edits、replace_all、错误文案、diff details、
 *             同文件并发编辑不丢更新
 *  9. 桥接层：tool_result.details 透传、图片内容块真的进了模型上下文
 *
 * 运行：bun run test:tools
 */

import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createModels } from '@earendil-works/pi-ai'
import type { Context as PiContext, Model as PiModel, SimpleStreamOptions } from '@earendil-works/pi-ai'
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from '@earendil-works/pi-ai/providers/faux'
import {
  getManagedBinaryPath,
  loadConfig,
  notifyToolsChanged,
  onToolsChanged,
  RG_TOOL,
  saveConfig,
  setBinaryProbeForTesting,
  type BinaryProbeResult,
} from '@zread-pi/utils'
import {
  FileEditTool,
  FileReadTool,
  FileWriteTool,
  GlobTool,
  GrepTool,
  LsTool,
  appendToolNotices,
  createAgent,
  expandBraces,
  findSearchBinary,
  matchGlobPath,
  resetSearchBinaryCache,
  toTruncationDetails,
  truncateHead,
  truncateLine,
  type SDKMessage,
  type ToolContext,
  type ToolInputParams,
  type ToolResult,
} from '../src/index.js'

const checks: Array<{ name: string; ok: boolean; detail?: string }> = []
function check(name: string, ok: boolean, detail?: string): void {
  checks.push({ name, ok, detail })
  const label = ok ? '  OK  ' : ' FAIL '
  const suffix = detail ? ' — ' + detail : ''
  console.log(label + ' ' + name + suffix)
}

function textOf(result: ToolResult): string {
  return typeof result.content === 'string' ? result.content : JSON.stringify(result.content)
}

function context(cwd: string, extra: Partial<ToolContext> = {}): ToolContext {
  return { cwd, ...extra }
}

async function callTool(
  tool: typeof LsTool,
  input: ToolInputParams,
  ctx: ToolContext,
): Promise<ToolResult> {
  return tool.call(input, ctx)
}

/** 临时把 rg/fd 探测结果置空，强制走纯 JS 兜底路径。 */
async function withoutBinaries<T>(fn: () => Promise<T>): Promise<T> {
  const previousRg = process.env.ZREAD_PI_RG_PATH
  const previousFd = process.env.ZREAD_PI_FD_PATH
  process.env.ZREAD_PI_RG_PATH = join(tmpdir(), 'zread-pi-nonexistent-rg')
  process.env.ZREAD_PI_FD_PATH = join(tmpdir(), 'zread-pi-nonexistent-fd')
  resetSearchBinaryCache()
  try {
    return await fn()
  } finally {
    if (previousRg === undefined) delete process.env.ZREAD_PI_RG_PATH
    else process.env.ZREAD_PI_RG_PATH = previousRg
    if (previousFd === undefined) delete process.env.ZREAD_PI_FD_PATH
    else process.env.ZREAD_PI_FD_PATH = previousFd
    resetSearchBinaryCache()
  }
}

function normalizeLines(text: string): string[] {
  return text
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith('['))
    .sort()
}

// ---------------------------------------------------------------------------
// 夹具：一个带 .gitignore / node_modules / CRLF / 图片 / 二进制的迷你仓库
// ---------------------------------------------------------------------------

const PNG_BYTES = Buffer.from(
  '89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000a49444154789c6300010000050001' +
    '0d0a2db40000000049454e44ae426082',
  'hex',
)

async function createFixture(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'zread-pi-tools-'))
  await mkdir(join(root, 'src', 'legacy'), { recursive: true })
  await mkdir(join(root, 'node_modules', 'pkg'), { recursive: true })
  await mkdir(join(root, 'dist'), { recursive: true })
  await mkdir(join(root, 'empty-dir'), { recursive: true })
  await mkdir(join(root, '.hidden'), { recursive: true })

  await writeFile(join(root, '.gitignore'), 'node_modules/\ndist/\n*.log\n', 'utf-8')
  await writeFile(join(root, 'README.md'), '# Fixture\n\nHello world from the read tool.\n', 'utf-8')
  await writeFile(join(root, 'src', 'app.ts'), 'export const APP = "hello"\nexport function run() { return APP }\n', 'utf-8')
  await writeFile(join(root, 'src', 'util.ts'), 'export const UtilValue = 42\n', 'utf-8')
  await writeFile(join(root, 'src', 'legacy', 'old.ts'), 'export const legacy = true\n', 'utf-8')
  await writeFile(join(root, 'src', 'data.json'), '{"name":"fixture"}\n', 'utf-8')
  await writeFile(join(root, 'dist', 'bundle.js'), 'const bundled = 1\n', 'utf-8')
  await writeFile(join(root, 'node_modules', 'pkg', 'index.js'), 'module.exports = 1\n', 'utf-8')
  await writeFile(join(root, 'debug.log'), 'log line\n', 'utf-8')
  await writeFile(join(root, '.hidden', 'secret.ts'), 'export const secret = 1\n', 'utf-8')
  await writeFile(join(root, 'crlf.txt'), 'line one\r\nline two\r\nline three\r\n', 'utf-8')
  await writeFile(join(root, 'bom.txt'), '\uFEFFalpha\nbeta\n', 'utf-8')
  await writeFile(join(root, 'logo.png'), PNG_BYTES)
  await writeFile(join(root, 'notes.pdf'), Buffer.from([0x25, 0x50, 0x44, 0x46, 0x00, 0x01, 0x02, 0x03]))
  await writeFile(join(root, 'empty.txt'), '', 'utf-8')
  await writeFile(join(root, 'many.txt'), Array.from({ length: 4200 }, (_, index) => `line ${index}`).join('\n'), 'utf-8')

  // 「在 git 仓库内」的分支：(fd/rg 默认只在 git 仓库内应用 .gitignore，
  // 上游为此写了 `--no-require-git` 的反向分支，这里造一个带 .git 的搜索根来覆盖它)
  await mkdir(join(root, 'gitlike', '.git'), { recursive: true })
  await mkdir(join(root, 'gitlike', 'skipdir'), { recursive: true })
  await writeFile(join(root, 'gitlike', '.gitignore'), 'ignored.txt\nskipdir/\n', 'utf-8')
  await writeFile(join(root, 'gitlike', 'kept.txt'), 'KEEP_TOKEN\n', 'utf-8')
  await writeFile(join(root, 'gitlike', 'ignored.txt'), 'IGNORED_TOKEN\n', 'utf-8')
  await writeFile(join(root, 'gitlike', 'skipdir', 'nested.txt'), 'IGNORED_TOKEN\n', 'utf-8')

  // 「并发编辑」用的工作文件
  const concurrencyDir = join(root, 'concurrency')
  await mkdir(concurrencyDir, { recursive: true })
  await writeFile(join(concurrencyDir, 'shared.txt'), 'ANCHOR\n', 'utf-8')
  return root
}

const fixture = await createFixture()
const ctx = context(fixture)

// 外部工具配置来自 ~/.zread-pi/config.yaml，测试必须隔离（否则会读到开发机的真实配置）
const toolsHome = await mkdtemp(join(tmpdir(), 'zread-pi-tools-home-'))
const managedDir = join(toolsHome, 'bin')
process.env.HOME = toolsHome
process.env.USERPROFILE = toolsHome
process.env.ZREAD_PI_TOOLS_DIR = managedDir
delete process.env.ZREAD_PI_RG_PATH
delete process.env.ZREAD_PI_FD_PATH

try {
  // -------------------------------------------------------------------------
  console.log('\n▶ 1. 共享截断设施（直接复用 vendor 的 pi-agent-core 实现）')
  // -------------------------------------------------------------------------
  const small = truncateHead('a\nb\nc')
  check('truncateHead 未超限时不截断', small.truncated === false && small.outputLines === 3 && small.content === 'a\nb\nc')

  const byLines = truncateHead('l1\nl2\nl3\nl4\nl5', { maxLines: 2 })
  check(
    'truncateHead 行上限生效且不返回半行',
    byLines.truncated && byLines.truncatedBy === 'lines' && byLines.content === 'l1\nl2' && byLines.totalLines === 5,
    JSON.stringify({ by: byLines.truncatedBy, out: byLines.content }),
  )

  const byBytes = truncateHead(`${'x'.repeat(40)}\n${'y'.repeat(40)}`, { maxBytes: 50 })
  check(
    'truncateHead 字节上限生效',
    byBytes.truncated && byBytes.truncatedBy === 'bytes' && byBytes.content === 'x'.repeat(40),
    JSON.stringify({ by: byBytes.truncatedBy, len: byBytes.content.length }),
  )

  const longLine = truncateLine(`head${'z'.repeat(600)}`, 500)
  check(
    'truncateLine 长行截断并带后缀',
    longLine.wasTruncated && longLine.text.endsWith('... [truncated]') && longLine.text.length === 500 + '... [truncated]'.length,
    `len=${longLine.text.length}`,
  )

  check(
    'appendToolNotices 无提示时不留空行',
    appendToolNotices('body', []) === 'body' && appendToolNotices('body', ['a', 'b']) === 'body\n\n[a. b]',
  )

  const details = toTruncationDetails(byLines)
  check(
    'toTruncationDetails 只保留元信息（不含 content 副本）',
    details.truncatedBy === 'lines' && details.totalLines === 5 && !('content' in details),
    JSON.stringify(details),
  )

  // -------------------------------------------------------------------------
  console.log('\n▶ 2. glob 语义（与 fd --glob 对齐）')
  // -------------------------------------------------------------------------
  check('无 "/" 的 pattern 匹配 basename（*.ts 命中嵌套文件）', matchGlobPath('src/app.ts', '*.ts') && matchGlobPath('a.ts', '*.ts'))
  check('无 "/" 的 pattern 不命中非目标扩展名', !matchGlobPath('src/app.js', '*.ts'))
  check('**/*.ts 命中任意深度', matchGlobPath('src/app.ts', '**/*.ts') && matchGlobPath('src/legacy/old.ts', '**/*.ts'))
  check('src/**/*.ts 只命中 src 下', matchGlobPath('src/legacy/old.ts', 'src/**/*.ts') && !matchGlobPath('other/old.ts', 'src/**/*.ts'))
  check('src/** 命中 src 下所有层级', matchGlobPath('src/a/b/c.ts', 'src/**'))
  check('src/*.ts 只命中一层', matchGlobPath('src/app.ts', 'src/*.ts') && !matchGlobPath('src/legacy/old.ts', 'src/*.ts'))
  check('花括号展开（含嵌套）', expandBraces('a{b,c}d').join(',') === 'abd,acd' && expandBraces('x{1,{2,3}}').join(',') === 'x1,x2,x3')
  check('花括号匹配', matchGlobPath('src/app.ts', 'src/*.{ts,tsx}') && matchGlobPath('src/app.tsx', 'src/*.{ts,tsx}'))
  check('字符类匹配', matchGlobPath('a.ts', '[ab].ts') && !matchGlobPath('c.ts', '[ab].ts'))

  // -------------------------------------------------------------------------
  console.log('\n▶ 3. Ls（新增工具）')
  // -------------------------------------------------------------------------
  const lsRoot = await callTool(LsTool, {}, ctx)
  const lsRootText = textOf(lsRoot)
  const lsLines = lsRootText.split('\n')
  check('Ls 目录带 "/" 后缀', lsLines.includes('src/') && lsLines.includes('empty-dir/'))
  check('Ls 包含 dotfile / 隐藏目录', lsLines.includes('.gitignore') && lsLines.includes('.hidden/'))
  check(
    'Ls 大小写不敏感字典序',
    JSON.stringify(lsLines) === JSON.stringify([...lsLines].sort((a, b) => (a.toLowerCase() < b.toLowerCase() ? -1 : a.toLowerCase() > b.toLowerCase() ? 1 : 0))),
    lsLines.slice(0, 6).join(','),
  )
  check('Ls 子目录列举', textOf(await callTool(LsTool, { path: 'src' }, ctx)).split('\n').includes('legacy/'))

  const lsLimited = await callTool(LsTool, { limit: 3 }, ctx)
  check('Ls 条目上限提示', textOf(lsLimited).includes('3 entries limit reached'), textOf(lsLimited).split('\n').pop())
  check('Ls details 带 entryLimitReached', (lsLimited.details as { entryLimitReached?: number } | undefined)?.entryLimitReached === 3)

  check('Ls 空目录', textOf(await callTool(LsTool, { path: 'empty-dir' }, ctx)) === '(empty directory)')
  const lsFile = await callTool(LsTool, { path: 'README.md' }, ctx)
  check('Ls 对文件报错', lsFile.is_error === true && textOf(lsFile).includes('Not a directory'))
  const lsMissing = await callTool(LsTool, { path: 'nope' }, ctx)
  check('Ls 对不存在路径报错', lsMissing.is_error === true && textOf(lsMissing).includes('Path not found'))

  // -------------------------------------------------------------------------
  console.log('\n▶ 4. Glob（替换实现）')
  // -------------------------------------------------------------------------
  const globTs = textOf(await callTool(GlobTool, { pattern: '**/*.ts' }, ctx))
  const globTsLines = globTs.split('\n')
  check('Glob 输出相对 POSIX 路径', globTsLines.includes('src/app.ts') && !globTs.includes(fixture) && !globTs.includes('\\'))
  check('Glob 结果按字典序排序', JSON.stringify(globTsLines) === JSON.stringify([...globTsLines].sort()))
  check('Glob 命中多层级', globTsLines.includes('src/legacy/old.ts'))
  check('Glob 尊重 .gitignore（dist 不出现在结果里）', !globTs.includes('dist/') && !globTs.includes('debug.log'))
  check('Glob 不进入 node_modules', !globTs.includes('node_modules'))
  check('Glob 无匹配时的文案', textOf(await callTool(GlobTool, { pattern: 'src/*.py' }, ctx)).includes('No files matching pattern'))
  const globMissing = await callTool(GlobTool, { pattern: '*.ts', path: 'nope' }, ctx)
  check('Glob 搜索根不存在时报错', globMissing.is_error === true && textOf(globMissing).includes('Path not found'))

  const globLimited = await callTool(GlobTool, { pattern: '**/*.ts', limit: 2 }, ctx)
  check('Glob 结果上限提示', textOf(globLimited).includes('2 results limit reached'))
  check('Glob details 记录 usedFallback 与 count', typeof (globLimited.details as { usedFallback?: boolean })?.usedFallback === 'boolean')

  // 两条执行路径一致性
  const systemGlob = normalizeLines(globTs)
  const fallbackGlob = await withoutBinaries(async () => normalizeLines(textOf(await callTool(GlobTool, { pattern: '**/*.ts' }, ctx))))
  check(
    `Glob 两条路径结果一致（fd=${findSearchBinary('fd') ?? '无'} / JS 兜底）`,
    JSON.stringify(systemGlob) === JSON.stringify(fallbackGlob),
    `system=${systemGlob.join('|')} fallback=${fallbackGlob.join('|')}`,
  )

  // -------------------------------------------------------------------------
  console.log('\n▶ 5. Grep（替换实现）')
  // -------------------------------------------------------------------------
  const grepApp = await callTool(GrepTool, { pattern: 'APP', path: '.' }, ctx)
  const grepAppText = textOf(grepApp)
  check('Grep content 模式输出 相对路径:行号: 文本', /^src\/app\.ts:\d+: /.test(grepAppText), grepAppText.split('\n')[0])
  check('Grep 输出相对路径而非绝对路径', !grepAppText.includes(fixture))
  check('Grep 命中行号正确', grepAppText.includes('src/app.ts:1:'))
  check(
    'Grep 以搜索根为基准计算相对路径',
    /^app\.ts:\d+: /.test(textOf(await callTool(GrepTool, { pattern: 'APP', path: 'src' }, ctx))),
    textOf(await callTool(GrepTool, { pattern: 'APP', path: 'src' }, ctx)).split('\n')[0],
  )

  const grepIgnoreCase = textOf(await callTool(GrepTool, { pattern: 'HELLO', ignoreCase: true, path: '.' }, ctx))
  check(
    'Grep ignoreCase 生效（大写 pattern 命中小写内容）',
    grepIgnoreCase.includes('src/app.ts:1:') && grepIgnoreCase.includes('hello'),
    grepIgnoreCase.split('\n')[0],
  )
  check(
    'Grep 区分大小写（默认不开启 ignoreCase 时大写 pattern 不命中）',
    textOf(await callTool(GrepTool, { pattern: 'HELLO', path: '.' }, ctx)).includes('No matches found'),
  )

  const grepLiteral = textOf(await callTool(GrepTool, { pattern: 'const APP = "hello"', literal: true, path: '.' }, ctx))
  check('Grep literal 生效（正则元字符按字面量处理）', grepLiteral.includes('src/app.ts:1:'))

  const grepGlob = textOf(await callTool(GrepTool, { pattern: 'legacy', glob: '*.ts', path: '.' }, ctx))
  check('Grep glob 过滤器生效', grepGlob.includes('src/legacy/old.ts') && !grepGlob.includes('data.json'))

  const grepContext = textOf(await callTool(GrepTool, { pattern: 'UtilValue', context: 1, path: '.' }, ctx))
  check('Grep context 模式给出上下文行（"-" 前缀）', /^src\/util\.ts-\d+- /m.test(grepContext), grepContext.split('\n').slice(0, 3).join(' | '))

  const grepFiles = textOf(await callTool(GrepTool, { pattern: 'export', output_mode: 'files_with_matches', path: '.' }, ctx))
  check(
    'Grep files_with_matches 模式',
    grepFiles.split('\n').includes('src/app.ts') && !grepFiles.includes(':'),
    grepFiles.split('\n').slice(0, 4).join(','),
  )

  const grepCount = textOf(await callTool(GrepTool, { pattern: 'export', output_mode: 'count', path: '.' }, ctx))
  check('Grep count 模式输出 path:count', /^src\/app\.ts:\d+$/m.test(grepCount), grepCount.split('\n')[0])

  const grepLimited = await callTool(GrepTool, { pattern: 'export', limit: 1, path: 'src' }, ctx)
  check('Grep 命中上限提示', textOf(grepLimited).includes('1 matches limit reached'), textOf(grepLimited).split('\n').pop())
  check('Grep details 带 matchLimitReached', (grepLimited.details as { matchLimitReached?: number } | undefined)?.matchLimitReached === 1)

  const grepIgnored = textOf(await callTool(GrepTool, { pattern: 'log line', path: '.' }, ctx))
  check('Grep 尊重 .gitignore（*.log 被跳过）', grepIgnored.includes('No matches found'), grepIgnored.split('\n')[0])
  check(
    'Grep 不在 git 仓库内也应用 .gitignore（dist/ 被跳过）',
    textOf(await callTool(GrepTool, { pattern: 'const bundled', path: '.' }, ctx)).includes('No matches found'),
  )
  check(
    'Grep 不进入 node_modules',
    textOf(await callTool(GrepTool, { pattern: 'module.exports', path: '.' }, ctx)).includes('No matches found'),
  )
  check(
    'Grep 无匹配时的文案',
    textOf(await callTool(GrepTool, { pattern: 'zzz-definitely-absent-zzz', path: 'src' }, ctx)).includes('No matches found'),
  )

  const grepBadRegex = await callTool(GrepTool, { pattern: '([unclosed', path: 'src' }, ctx)
  check('Grep 非法正则给出可读错误', grepBadRegex.is_error === true && textOf(grepBadRegex).includes('Invalid regular expression'), textOf(grepBadRegex))

  const grepLongLine = textOf(await callTool(GrepTool, { pattern: 'const bundled', path: 'dist/bundle.js' }, ctx))
  check('Grep 能搜索显式指定的忽略文件（显式目标不被误杀）', grepLongLine.includes('bundle.js'), grepLongLine.split('\n')[0])

  // 两条执行路径一致性（含 .gitignore 语义：两条路径都必须跳过 dist/ 与 *.log）
  const systemGrep = await callTool(GrepTool, { pattern: 'export const', path: '.' }, ctx)
  const fallbackGrep = await withoutBinaries(async () => callTool(GrepTool, { pattern: 'export const', path: '.' }, ctx))
  check(
    `Grep 两条路径结果一致（rg=${findSearchBinary('rg') ?? '无'} / JS 兜底）`,
    JSON.stringify(normalizeLines(textOf(systemGrep))) === JSON.stringify(normalizeLines(textOf(fallbackGrep))),
    `system=${normalizeLines(textOf(systemGrep)).length} fallback=${normalizeLines(textOf(fallbackGrep)).length}`,
  )
  const systemGrepIgnored = textOf(await callTool(GrepTool, { pattern: 'bundled|log line', path: '.' }, ctx))
  const fallbackGrepIgnored = textOf(await withoutBinaries(async () => callTool(GrepTool, { pattern: 'bundled|log line', path: '.' }, ctx)))
  check(
    'Grep 两条路径的 .gitignore 行为一致（都跳过 dist/ 与 *.log）',
    systemGrepIgnored.includes('No matches found') && fallbackGrepIgnored.includes('No matches found'),
    `system=${systemGrepIgnored.split('\n')[0]} fallback=${fallbackGrepIgnored.split('\n')[0]}`,
  )

  // ===== git 仓库内（存在 .git）的 .gitignore 语义：fd/rg 与 JS 兜底必须一致 =====
  const inRepoGlob = normalizeLines(textOf(await callTool(GlobTool, { pattern: '**/*.txt', path: 'gitlike' }, ctx)))
  const inRepoGlobFallback = await withoutBinaries(async () =>
    normalizeLines(textOf(await callTool(GlobTool, { pattern: '**/*.txt', path: 'gitlike' }, ctx))),
  )
  check(
    'Grep/Glob 在 git 仓库内仍应用同目录 .gitignore',
    JSON.stringify(inRepoGlob) === JSON.stringify(['kept.txt']) && JSON.stringify(inRepoGlobFallback) === JSON.stringify(['kept.txt']),
    `system=${inRepoGlob.join(',')} fallback=${inRepoGlobFallback.join(',')}`,
  )
  const inRepoGrep = textOf(await callTool(GrepTool, { pattern: 'IGNORED_TOKEN', path: 'gitlike' }, ctx))
  const inRepoGrepFallback = await withoutBinaries(async () =>
    textOf(await callTool(GrepTool, { pattern: 'IGNORED_TOKEN', path: 'gitlike' }, ctx)),
  )
  check(
    '在 git 仓库内：ignore 命中的文件不被 Grep 搜到（两条路径一致）',
    inRepoGrep.includes('No matches found') && inRepoGrepFallback.includes('No matches found'),
    `system=${inRepoGrep.split('\n')[0]}`,
  )
  check(
    '在 git 仓库内：未 ignore 的文件正常命中（两条路径一致）',
    textOf(await callTool(GrepTool, { pattern: 'KEEP_TOKEN', path: 'gitlike' }, ctx)).includes('kept.txt:1:') &&
      (await withoutBinaries(async () => textOf(await callTool(GrepTool, { pattern: 'KEEP_TOKEN', path: 'gitlike' }, ctx)))).includes('kept.txt:1:'),
  )

  // -------------------------------------------------------------------------
  console.log('\n▶ 6. Read（替换实现）')
  // -------------------------------------------------------------------------
  const readReadme = textOf(await callTool(FileReadTool, { file_path: 'README.md' }, ctx))
  check('Read 返回原始文本（无行号前缀）', readReadme.startsWith('# Fixture') && !readReadme.includes('\t'))
  check('Read 接受上游的 path 参数别名', textOf(await callTool(FileReadTool, { path: 'README.md' }, ctx)).startsWith('# Fixture'))

  const readOffset = textOf(await callTool(FileReadTool, { file_path: 'README.md', offset: 3 }, ctx))
  check('Read offset 是 1-based', readOffset.startsWith('Hello world'), readOffset.split('\n')[0])

  const readLimit = textOf(await callTool(FileReadTool, { file_path: 'README.md', limit: 1 }, ctx))
  check('Read limit 后给出续读提示', readLimit.includes('Use offset=2 to continue.'), readLimit.replace(/\n/g, '\\n'))

  const readTruncated = textOf(await callTool(FileReadTool, { file_path: 'many.txt' }, ctx))
  check(
    'Read 行数截断并给出 offset 续读提示',
    readTruncated.includes('[Showing lines 1-2000 of 4200. Use offset=2001 to continue.]'),
    readTruncated.split('\n').slice(-1)[0],
  )

  const readDir = await callTool(FileReadTool, { file_path: 'src' }, ctx)
  check(
    'Read 目录报错点名 Ls（不再引用不存在的 Bash）',
    readDir.is_error === true && textOf(readDir).includes('Ls tool') && !textOf(readDir).includes('Bash'),
    textOf(readDir),
  )

  const readMissing = await callTool(FileReadTool, { file_path: 'nope.txt' }, ctx)
  check('Read 文件不存在时报错', readMissing.is_error === true && textOf(readMissing).includes('File not found'))

  const readImageNote = await callTool(FileReadTool, { file_path: 'logo.png' }, ctx)
  check(
    'Read 按 magic number 识别 PNG；模型不支持图片时回退为文本说明',
    readImageNote.is_error !== true && textOf(readImageNote).includes('image/png') && textOf(readImageNote).includes('omitted'),
    textOf(readImageNote),
  )

  const readImageBlock = await callTool(FileReadTool, { file_path: 'logo.png' }, context(fixture, { supportsImages: true }))
  const imageBlocks = Array.isArray(readImageBlock.content) ? readImageBlock.content : []
  check(
    'Read 在支持图片的模型上回传 image 内容块',
    imageBlocks.some((block) => block.type === 'image') && readImageBlock.details !== undefined,
    JSON.stringify(imageBlocks.map((block) => block.type)),
  )

  const readBinaryNote = await callTool(FileReadTool, { file_path: 'notes.pdf' }, ctx)
  check('Read 对非图片二进制给出说明而不是乱码', textOf(readBinaryNote).includes('Binary file'), textOf(readBinaryNote))

  const readCrlf = textOf(await callTool(FileReadTool, { file_path: 'crlf.txt' }, ctx))
  check('Read 读取 CRLF 文件', readCrlf.startsWith('line one') && readCrlf.includes('line three'))

  check('Read 空文件提示', textOf(await callTool(FileReadTool, { file_path: 'empty.txt' }, ctx)) === '(empty file)')

  // -------------------------------------------------------------------------
  console.log('\n▶ 7. Write（替换实现 + 写队列）')
  // -------------------------------------------------------------------------
  const writeNew = await callTool(FileWriteTool, { file_path: 'generated/deep/out.md', content: '# out\nsecond\n' }, ctx)
  check('Write 自动创建父目录', (await readFile(join(fixture, 'generated', 'deep', 'out.md'), 'utf-8')) === '# out\nsecond\n')
  check('Write details 标记 created', (writeNew.details as { created?: boolean } | undefined)?.created === true)
  check('Write 结果文本用请求路径', textOf(writeNew) === 'Successfully wrote to generated/deep/out.md', textOf(writeNew))

  const writeAgain = await callTool(FileWriteTool, { file_path: 'generated/deep/out.md', content: 'overwritten\n' }, ctx)
  check(
    'Write 覆盖已有文件并标记 created=false',
    (writeAgain.details as { created?: boolean } | undefined)?.created === false &&
      (await readFile(join(fixture, 'generated', 'deep', 'out.md'), 'utf-8')) === 'overwritten\n',
  )

  // 并发写同一文件：写队列保证不会交错/损坏
  await writeFile(join(fixture, 'concurrency', 'writes.txt'), 'start\n', 'utf-8')
  await Promise.all(
    Array.from({ length: 8 }, (_, index) =>
      callTool(
        FileWriteTool,
        { file_path: 'concurrency/writes.txt', content: `${'x'.repeat(2000)}#${index}\n` },
        ctx,
      ),
    ),
  )
  const writtenContent = await readFile(join(fixture, 'concurrency', 'writes.txt'), 'utf-8')
  check(
    '并发写同一文件：结果完整且是某一次写入的原文（无交错）',
    /^x{2000}#\d\n$/.test(writtenContent),
    `len=${writtenContent.length}`,
  )

  // -------------------------------------------------------------------------
  console.log('\n▶ 8. Edit（替换实现 + 写队列）')
  // -------------------------------------------------------------------------
  await writeFile(join(fixture, 'edit-target.txt'), 'alpha\nbeta\ngamma\n', 'utf-8')
  const editBasic = await callTool(
    FileEditTool,
    { file_path: 'edit-target.txt', old_string: 'beta', new_string: 'BETA' },
    ctx,
  )
  check('Edit old_string/new_string 生效', (await readFile(join(fixture, 'edit-target.txt'), 'utf-8')) === 'alpha\nBETA\ngamma\n')
  check(
    'Edit details 带 diff 与首行变更行号',
    typeof (editBasic.details as { diff?: string })?.diff === 'string' &&
      (editBasic.details as { firstChangedLine?: number }).firstChangedLine === 2 &&
      (editBasic.details as { patch?: string }).patch?.includes('---'),
    JSON.stringify((editBasic.details as { firstChangedLine?: number })?.firstChangedLine),
  )

  // CRLF：磁盘是 CRLF，模型给 LF 的 old_string
  const crlfPath = join(fixture, 'edit-crlf.txt')
  await writeFile(crlfPath, 'one\r\ntwo\r\nthree\r\n', 'utf-8')
  const editCrlf = await callTool(
    FileEditTool,
    { file_path: 'edit-crlf.txt', old_string: 'one\ntwo', new_string: 'one\nTWO' },
    ctx,
  )
  const crlfResult = await readFile(crlfPath, 'utf-8')
  check(
    'Edit 归一化 CRLF：LF 的 old_string 能命中 CRLF 文件，且行尾保持 CRLF',
    editCrlf.is_error !== true && crlfResult === 'one\r\nTWO\r\nthree\r\n',
    JSON.stringify(crlfResult),
  )

  // BOM：必须保留
  const bomPath = join(fixture, 'edit-bom.txt')
  await writeFile(bomPath, '\uFEFFalpha\nbeta\n', 'utf-8')
  await callTool(FileEditTool, { file_path: 'edit-bom.txt', old_string: 'beta', new_string: 'BETA' }, ctx)
  const bomResult = await readFile(bomPath, 'utf-8')
  check('Edit 保留 BOM', bomResult.startsWith('\uFEFF') && bomResult.includes('BETA'), JSON.stringify(bomResult.slice(0, 8)))

  // replace_all
  await writeFile(join(fixture, 'edit-all.txt'), 'x-x-x\n', 'utf-8')
  await callTool(
    FileEditTool,
    { file_path: 'edit-all.txt', old_string: 'x', new_string: 'y', replace_all: true },
    ctx,
  )
  check('Edit replace_all 替换全部出现', (await readFile(join(fixture, 'edit-all.txt'), 'utf-8')) === 'y-y-y\n')

  // 多段 disjoint edits（上游形态）
  await writeFile(join(fixture, 'edit-multi.txt'), 'first\nsecond\nthird\nfourth\n', 'utf-8')
  const editMulti = await callTool(
    FileEditTool,
    {
      file_path: 'edit-multi.txt',
      edits: [
        { oldText: 'first', newText: 'FIRST' },
        { oldText: 'fourth', newText: 'FOURTH' },
      ],
    },
    ctx,
  )
  check(
    'Edit 支持 edits[] 多段不相邻替换',
    editMulti.is_error !== true &&
      (await readFile(join(fixture, 'edit-multi.txt'), 'utf-8')) === 'FIRST\nsecond\nthird\nFOURTH\n',
    textOf(editMulti),
  )

  // edits 传成 JSON 字符串（部分模型会这样发）
  await writeFile(join(fixture, 'edit-json.txt'), 'a\nb\n', 'utf-8')
  const editJson = await callTool(
    FileEditTool,
    { file_path: 'edit-json.txt', edits: JSON.stringify([{ oldText: 'a', newText: 'A' }]) as unknown as ToolInputParams[string] },
    ctx,
  )
  check('Edit 解析 JSON 字符串形式的 edits', editJson.is_error !== true && (await readFile(join(fixture, 'edit-json.txt'), 'utf-8')) === 'A\nb\n')

  const editDuplicate = await callTool(FileEditTool, { file_path: 'edit-multi.txt', old_string: 'F', new_string: 'Z' }, ctx)
  check('Edit 非唯一匹配时报错', editDuplicate.is_error === true && textOf(editDuplicate).includes('occurrences'), textOf(editDuplicate))

  const editNotFound = await callTool(FileEditTool, { file_path: 'edit-multi.txt', old_string: 'absent', new_string: 'Z' }, ctx)
  check('Edit 找不到目标文本时报错', editNotFound.is_error === true && textOf(editNotFound).includes('Could not find the exact text'))

  const editMissing = await callTool(FileEditTool, { file_path: 'nope.txt', old_string: 'a', new_string: 'b' }, ctx)
  check('Edit 文件不存在时报错', editMissing.is_error === true && textOf(editMissing).includes('Could not edit file'))

  // 并发编辑同一文件：没有队列时会丢更新
  const sharedPath = join(fixture, 'concurrency', 'shared.txt')
  await writeFile(sharedPath, 'ANCHOR\n', 'utf-8')
  const parallelEdits = Array.from({ length: 16 }, (_, index) =>
    callTool(
      FileEditTool,
      { file_path: 'concurrency/shared.txt', old_string: 'ANCHOR', new_string: `ANCHOR\nmarker-${index}` },
      ctx,
    ),
  )
  const editResults = await Promise.all(parallelEdits)
  const sharedContent = await readFile(sharedPath, 'utf-8')
  const markers = Array.from({ length: 16 }, (_, index) => `marker-${index}`).filter((marker) => sharedContent.includes(marker))
  check(
    '并发编辑同一文件：16 个编辑全部生效（写队列串行化，无丢更新）',
    editResults.every((result) => result.is_error !== true) && markers.length === 16,
    `applied=${markers.length}/16`,
  )

  // -------------------------------------------------------------------------
  console.log('\n▶ 9. 桥接层：details 透传 + 图片进入模型上下文')
  // -------------------------------------------------------------------------
  const faux = fauxProvider({ tokensPerSecond: 0 })
  const models = createModels()
  models.setProvider(faux.provider)
  const model = faux.getModel('faux-model') ?? faux.models[0]
  check('faux 模型声明支持图片输入（用于图片路径断言）', model.input.includes('image'))

  const capturedContexts: PiContext[] = []
  faux.setResponses([
    fauxAssistantMessage([fauxToolCall('Read', { file_path: 'logo.png' }, { id: 'call_img' })]),
    fauxAssistantMessage('已读取图片'),
  ])

  const agent = createAgent({
    model: String(model.id),
    cwd: fixture,
    maxTurns: 4,
    tools: [FileReadTool],
    includePartialMessages: false,
    runtimeOverride: {
      model: model as PiModel<any>,
      streamFn: (streamModel, streamContext, streamOptions: SimpleStreamOptions | undefined) => {
        capturedContexts.push(streamContext)
        return models.streamSimple(streamModel, streamContext, streamOptions)
      },
    },
  })

  const toolResultEvents: Array<{ output: string; details?: unknown }> = []
  let bridgeResult: string | undefined
  for await (const message of agent.query('读一下 logo.png') as AsyncIterable<SDKMessage>) {
    if (message.type === 'tool_result') {
      toolResultEvents.push({ output: message.result.output, details: message.result.details })
    }
    if (message.type === 'result') bridgeResult = message.subtype
  }
  await agent.close()

  check('桥接层：查询成功收敛', bridgeResult === 'success', String(bridgeResult))
  check(
    '桥接层：tool_result 输出含图片占位（说明 image 块被保留）',
    toolResultEvents.some((event) => event.output.includes('[image image/png]')),
    JSON.stringify(toolResultEvents.map((event) => event.output)),
  )
  check(
    '桥接层：tool_result.details 透传到 SDK 事件',
    toolResultEvents.some((event) => (event.details as { path?: string } | undefined)?.path?.endsWith('logo.png')),
    JSON.stringify(toolResultEvents.map((event) => event.details)),
  )
  const sawImageInContext = capturedContexts.some((streamContext) =>
    (streamContext.messages ?? []).some((message) => {
      const content = (message as { content?: unknown }).content
      return Array.isArray(content) && content.some((block) => (block as { type?: string }).type === 'image')
    }),
  )
  check('桥接层：image 内容块真的进入模型上下文', sawImageInContext)

  // -------------------------------------------------------------------------
  console.log('\n▶ 10. 外部工具启用开关 → 搜索工具二进制解析')
  // -------------------------------------------------------------------------
  // 造一个「托管安装」的 rg，并把探测替换成基于文件是否存在的假实现
  await mkdir(managedDir, { recursive: true })
  await writeFile(getManagedBinaryPath(RG_TOOL), 'fake', 'utf-8')
  setBinaryProbeForTesting((path: string): BinaryProbeResult =>
    existsSync(path)
      ? { runnable: true, version: '14.1.1', args: ['--version'], exitCode: 0, output: 'ripgrep 14.1.1' }
      : { runnable: false, error: 'ENOENT' },
  )
  resetSearchBinaryCache()
  check('启用时：findSearchBinary 命中托管目录', findSearchBinary('rg') === getManagedBinaryPath(RG_TOOL), String(findSearchBinary('rg')))

  // 停用（配置界面的 /config/tools 写的就是这个字段）
  const toolsConfig = await loadConfig()
  toolsConfig.tools = { ...toolsConfig.tools, rg: { enabled: false } }
  await saveConfig(toolsConfig)
  resetSearchBinaryCache()
  check('停用后：findSearchBinary 返回 null（Grep 退回纯 JS 兜底）', findSearchBinary('rg') === null)

  // 重新启用后必须立刻可用（配置界面保存会触发 notifyToolsChanged）
  const reEnabledConfig = await loadConfig()
  reEnabledConfig.tools = { ...reEnabledConfig.tools, rg: { enabled: true } }
  await saveConfig(reEnabledConfig)
  notifyToolsChanged()
  check('重新启用并广播变更后：缓存失效、立刻可用', findSearchBinary('rg') === getManagedBinaryPath(RG_TOOL), String(findSearchBinary('rg')))

  const seenChanges: number[] = []
  const unsubscribe = onToolsChanged(() => seenChanges.push(Date.now()))
  notifyToolsChanged()
  unsubscribe()
  notifyToolsChanged()
  check('onToolsChanged 订阅/取消订阅生效', seenChanges.length === 1, `events=${seenChanges.length}`)

  setBinaryProbeForTesting(undefined)
} finally {
  await rm(fixture, { recursive: true, force: true })
  await rm(toolsHome, { recursive: true, force: true })
}

const failed = checks.filter((entry) => !entry.ok)
console.log(`\n结果：${checks.length - failed.length}/${checks.length} 通过`)
if (failed.length > 0) {
  console.error('失败项：', failed.map((entry) => entry.name).join(', '))
  process.exit(1)
}
