/**
 * logger.ts —— 日志总线（对齐 cordis / logger-console）回归
 *
 * 全程离线；ZREAD_PI_HOME 指向临时目录，绝不碰真实 ~/.zread-pi。
 *
 * 覆盖（对应计划的 8 组断言）：
 *  ① 记录形状：sn 单调、ts 递增、name/type/level 正确
 *  ② printf 全占位符 + Error/cause/AggregateError 展开 + 单行截断
 *  ③ Logger.code 哈希与 harness 逐字一致（黄金值取自 vendor/cordis 实跑）
 *  ④ 按 exporter / 按 logger 名的级别阈值 + ZREAD_PI_LOG_LEVEL 解析（含非法值回退）
 *  ⑤ 多 exporter 广播 + 1000 条环形缓冲淘汰
 *  ⑥ file-exporter：行格式 / 跨天路径 / 保留期清理 / needle 兼容
 *  ⑦ 命名 logger 端到端（名字进文件）
 *  ⑧ getLogFile() 路径稳定性 + 兼容层（progress/success/debug 标记）
 *
 * 运行：bun run test:logger
 */

import { mkdir, mkdtemp, readFile, readdir, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import {
  ConsoleExporter,
  FileExporter,
  LoggerFormat,
  LoggerLevel,
  LoggerService,
  LOG_CONSOLE_ENV,
  LOG_JSONL_ENV,
  LOG_LEVEL_ENV,
  LOG_RETENTION_DAYS_ENV,
  LOG_TEXT_ENV,
  Time,
  addExporter,
  createLogger,
  defaultFormatters,
  detectColorLevel,
  getJsonlLogFilePath,
  getLogFile,
  getLogFilePath,
  getLoggerService,
  parseLogLevels,
  resetLoggerServiceForTesting,
  resolveExporterLevel,
  sweepOldLogFiles,
  DEFAULT_LOG_RETENTION_DAYS,
} from '../src/index.js';
import type { Exporter, Logger, Message } from '../src/index.js';

// ---------------------------------------------------------------------------
// 0) 隔离家目录（必须在首次记日志之前）
// ---------------------------------------------------------------------------

const home = await mkdtemp(join(tmpdir(), 'zread-pi-logger-'));
process.env.ZREAD_PI_HOME = home;

const checks: Array<{ name: string; ok: boolean; detail?: string }> = [];

function check(name: string, ok: boolean, detail?: string): void {
  checks.push({ name, ok, detail });
}

function capture(): { exporter: Exporter; messages: Message[] } {
  const messages: Message[] = [];
  return { messages, exporter: { export: (m: Message) => messages.push(m) } };
}

async function readLog(): Promise<string> {
  return readFile(getLogFile(), 'utf-8').catch(() => '');
}

// ---------------------------------------------------------------------------
// ① 记录形状
// ---------------------------------------------------------------------------

{
  const svc = new LoggerService();
  const { messages, exporter } = capture();
  exporter.levels = { default: LoggerLevel.DEBUG };
  svc.addExporter(exporter);
  const log = svc.createLogger('shape');
  log.info('a');
  log.warn('b');
  log.error('c');
  log.debug('d');

  check('记录数量 = 4', messages.length === 4, `n=${messages.length}`);
  check('name 统一为 shape', messages.every((m) => m.name === 'shape'));
  check(
    'type/level 对应正确',
    messages[0].type === 'info' && messages[0].level === LoggerLevel.INFO
      && messages[1].type === 'warn' && messages[1].level === LoggerLevel.WARN
      && messages[2].type === 'error' && messages[2].level === LoggerLevel.ERROR
      && messages[3].type === 'debug' && messages[3].level === LoggerLevel.DEBUG,
  );
  check('sn 从 1 开始严格单调', messages.every((m, i) => m.sn === i + 1), messages.map((m) => m.sn).join(','));
  check('ts 单调不减', messages.every((m, i) => i === 0 || m.ts >= messages[i - 1].ts));
  check('args 原样保留', messages[0].args.length === 1 && messages[0].args[0] === 'a');
}

// ---------------------------------------------------------------------------
// ② printf / Error 展开 / 截断（LoggerFormat 纯函数，黄金值取自 harness 实跑）
// ---------------------------------------------------------------------------

{
  const E: Exporter = { colors: false };
  const mk = (args: any[]): Message => ({ sn: 1, ts: 1700000000000, name: 'app', type: 'info', level: 1, args });

  check(
    'printf %s %d %o',
    LoggerFormat.format(E, mk(['%s %d %o', 'x', 42, { a: 1 }])) === 'x 42 {"a":1}',
    LoggerFormat.format(E, mk(['%s %d %o', 'x', 42, { a: 1 }])),
  );
  check('纯文本消息不被 printf 改动', LoggerFormat.format(E, mk(['plain text'])) === 'plain text');
  check('%% 转义', LoggerFormat.format(E, mk(['100%% ok'])) === '100% ok');
  check('%f 浮点', LoggerFormat.format(E, mk(['%f', 1.5])) === '1.5');
  check('%i/%d 截断小数', LoggerFormat.format(E, mk(['%i', 3.9])) === '3' && LoggerFormat.format(E, mk(['%d', 3.9])) === '3');
  check('未知占位符原样保留', LoggerFormat.format(E, mk(['%z stay'])) === '%z stay');
  check('剩余对象参数以 %o 追加', LoggerFormat.format(E, mk(['v', { a: 1 }])) === 'v {"a":1}');

  const err = new Error('boom');
  err.stack = 'Error: boom\n  at x';
  check('Error 首参走 stack', LoggerFormat.format(E, mk([err])) === 'Error: boom\n  at x');
  check('多行消息保留换行', LoggerFormat.format(E, mk(['l1\nl2'])) === 'l1\nl2');

  const E10: Exporter = { colors: false, maxLength: 10 };
  check('单行超长截断 + ...', LoggerFormat.format(E10, mk(['1234567890abcdef'])) === '1234567890...', 'len check');

  // Error 展开（方法级，与 cordis 的 cause / AggregateError 语义一致）
  const svc = new LoggerService();
  const { messages, exporter } = capture();
  svc.addExporter(exporter);
  const log = svc.createLogger('errs');

  const cause = new Error('inner');
  const outer = new Error('outer');
  (outer as Error & { cause?: unknown }).cause = cause;
  log.error(outer);
  // cause 分支：先递归记录 inner，再 fall-through 广播 outer → 2 条
  check('cause 链展开为 2 条（inner + outer）', messages.length === 2, `n=${messages.length}`);
  check('cause 链首条是 inner', messages[0].args[0] === cause);
  check('cause 链次条是 outer', messages[1].args[0] === outer);

  const agg = new AggregateError([new Error('e1'), new Error('e2')], 'agg');
  log.error(agg);
  const aggMessages = messages.slice(-2);
  // AggregateError：只展开子错误，聚合错误本身不重复广播
  check('AggregateError 拆成 2 条子错误', aggMessages.length === 2, `n=${aggMessages.length}`);
  check('AggregateError 本身不广播', !messages.some((m) => m.args[0] === agg));
  check('AggregateError 首条是 e1', (aggMessages[0].args[0] as Error).message === 'e1');
}

// ---------------------------------------------------------------------------
// ③ Logger.code 哈希（黄金值取自 vendor/cordis 实跑，保证逐字一致）
// ---------------------------------------------------------------------------

{
  check('defaultFormatters.s 基本可用', defaultFormatters.s(42) === '42' && defaultFormatters.c('x') === '');
  check('code(app) 16 色 = 6', LoggerFormat.code('app', 1) === 6);
  check('code(app) 256 色 = 57', LoggerFormat.code('app', 3) === 57);
  check('code(orchestrator) 16/256', LoggerFormat.code('orchestrator', 1) === 6 && LoggerFormat.code('orchestrator', 3) === 172);
  check('code(orchestrator.pages) 16/256', LoggerFormat.code('orchestrator.pages', 1) === 5 && LoggerFormat.code('orchestrator.pages', 3) === 209);
  check('code(tui.console) 256 = 179', LoggerFormat.code('tui.console', 3) === 179);
  check('code(analyzer.parser) 256 = 208', LoggerFormat.code('analyzer.parser', 3) === 208);
  check('code(name, false) → undefined（无着色）', LoggerFormat.code('app', false) === undefined);
  check('level >= 2 用 256 色板', LoggerFormat.code('app', 2) === LoggerFormat.code('app', 3));
  check('code 对同名稳定可复现', LoggerFormat.code('orchestrator.pages', 3) === LoggerFormat.code('orchestrator.pages', 3));
  check('color() 无色时原样返回', LoggerFormat.color({ colors: false }, 6, 'x') === 'x');
  check('color() 有色时包 ANSI', LoggerFormat.color({ colors: 1 }, 6, 'x') === '\u001b[36mx\u001b[0m');
  check('color() colors=1 丢弃 decoration', LoggerFormat.color({ colors: 1 }, 6, 'x', ';1') === '\u001b[36mx\u001b[0m');
  check('color() colors>=2 保留 decoration', LoggerFormat.color({ colors: 2 }, 6, 'x', ';1') === '\u001b[36;1mx\u001b[0m');
}

// ---------------------------------------------------------------------------
// ④ 级别阈值（resolveExporterLevel + parseLogLevels + 端到端）
// ---------------------------------------------------------------------------

{
  const levels = { default: LoggerLevel.INFO, orchestrator: LoggerLevel.DEBUG };
  check('前缀名命中（orchestrator.pages → debug）', resolveExporterLevel({ levels }, 'orchestrator.pages') === LoggerLevel.DEBUG);
  check('精确名命中（orchestrator → debug）', resolveExporterLevel({ levels }, 'orchestrator') === LoggerLevel.DEBUG);
  check('点号边界不误命中（orchestrator-lite → info）', resolveExporterLevel({ levels }, 'orchestrator-lite') === LoggerLevel.INFO);
  check('无名命中走 default', resolveExporterLevel({ levels }, 'other') === LoggerLevel.INFO);
  check('无 levels 时默认 INFO', resolveExporterLevel({}, 'x') === LoggerLevel.INFO);
  check('无 levels 时 logger 自身 level 生效', resolveExporterLevel({}, 'x', LoggerLevel.DEBUG) === LoggerLevel.DEBUG);
  check('具体名优先于 default', resolveExporterLevel({ levels: { default: LoggerLevel.DEBUG, app: LoggerLevel.ERROR } }, 'app') === LoggerLevel.ERROR);
  check('更长前缀优先', resolveExporterLevel(
    { levels: { a: LoggerLevel.DEBUG, 'a.b': LoggerLevel.ERROR } },
    'a.b.c',
  ) === LoggerLevel.ERROR);

  check(
    'parseLogLevels: default=info,orchestrator=debug',
    JSON.stringify(parseLogLevels('default=info,orchestrator=debug')) === JSON.stringify({ default: 1, orchestrator: 3 }),
  );
  check('parseLogLevels: 裸值作为 default', JSON.stringify(parseLogLevels('debug')) === JSON.stringify({ default: 3 }));
  check('parseLogLevels: 空串回退 default=info', JSON.stringify(parseLogLevels('')) === JSON.stringify({ default: 1 }));
  check('parseLogLevels: undefined 回退 default=info', JSON.stringify(parseLogLevels(undefined)) === JSON.stringify({ default: 1 }));
  check('parseLogLevels: 非法级别名被忽略并补 default', JSON.stringify(parseLogLevels('app=bogus')) === JSON.stringify({ default: 1 }));
  check('parseLogLevels: warning 别名 = warn', parseLogLevels('default=warning').default === LoggerLevel.WARN);
  check('parseLogLevels: 从环境变量读取', (() => {
    process.env[LOG_LEVEL_ENV] = 'default=error';
    const parsed = parseLogLevels(process.env[LOG_LEVEL_ENV]);
    delete process.env[LOG_LEVEL_ENV];
    return parsed.default === LoggerLevel.ERROR;
  })());

  // 端到端：exporter 的 levels 过滤
  // cordis 的 level 数值是「啰嗦度」：ERROR=0 最不啰嗦、DEBUG=3 最啰嗦；
  // 阈值 = 允许发出的最大啰嗦度（targetLevel < level 的记录被丢弃），
  // 因此阈值 WARN（2）会发出 error/info/warn，只丢弃 debug（3）。
  const svc = new LoggerService();
  const { messages, exporter } = capture();
  exporter.levels = { default: LoggerLevel.WARN, noisy: LoggerLevel.DEBUG };
  svc.addExporter(exporter);
  const noisy = svc.createLogger('noisy');
  const quiet = svc.createLogger('quiet');
  noisy.debug('kept-noisy-debug');
  quiet.debug('filtered-quiet-debug');
  quiet.info('kept-quiet-info');
  quiet.warn('kept-quiet-warn');
  quiet.error('kept-quiet-error');
  check(
    '级别阈值端到端：noisy=debug 全收，quiet=warn 只丢 debug',
    messages.length === 4
      && messages[0].args[0] === 'kept-noisy-debug'
      && messages[1].args[0] === 'kept-quiet-info'
      && messages[2].args[0] === 'kept-quiet-warn'
      && messages[3].args[0] === 'kept-quiet-error',
    JSON.stringify(messages.map((m) => m.args)),
  );
}

// ---------------------------------------------------------------------------
// ⑤ 多 exporter 广播 + 环形缓冲
// ---------------------------------------------------------------------------

{
  const svc = new LoggerService();
  const a = capture();
  const b = capture();
  svc.addExporter(a.exporter);
  svc.addExporter(b.exporter);
  const log = svc.createLogger('multi');
  log.info('one');
  log.info('two');
  check('两个 exporter 都收到全部消息', a.messages.length === 2 && b.messages.length === 2);
  check('两个 exporter 收到同一 sn', a.messages[1].sn === b.messages[1].sn);

  // 环形缓冲：默认 1000 条，超出淘汰最早的
  check('默认 bufferSize = 1000', svc.bufferSize === 1000);
  const small = new LoggerService();
  small.bufferSize = 5;
  const slog = small.createLogger('ring');
  for (let i = 0; i < 8; i += 1) slog.info(`m${i}`);
  check('环形缓冲淘汰到 bufferSize', small.buffer.length === 5, `len=${small.buffer.length}`);
  check('环形缓冲保留最后 5 条', small.buffer[0].args[0] === 'm3' && small.buffer[4].args[0] === 'm7',
    JSON.stringify(small.buffer.map((m) => m.args[0])));
  check('环形缓冲记录全部级别', small.buffer.every((m) => m.level === LoggerLevel.INFO));
  check('缓冲按 DEBUG 阈值收录 debug 记录', (() => {
    const s = new LoggerService();
    s.createLogger('d').debug('dbg-in-buffer');
    return s.buffer.some((m) => m.args[0] === 'dbg-in-buffer');
  })());
}

// ---------------------------------------------------------------------------
// ⑥ file-exporter：行格式 / 跨天路径 / 保留期清理 / needle 兼容
// ---------------------------------------------------------------------------

{
  const fe = new FileExporter();
  const line = fe.render({ sn: 7, ts: 1700000000000, name: 'demo', type: 'warn', level: 2, args: ['%s', 'hello'] });
  check('file 行格式 = [时间] [WARN] 名字 消息', /^\[\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d{3}\] \[WARN\] demo hello$/.test(line), line);
  check('file 行无 ANSI（colors=false）', !line.includes('\u001b'));

  // 跨天路径：日期取写入时刻
  const today = getLogFilePath(new Date());
  const yesterday = getLogFilePath(new Date(Date.now() - 86400000));
  check('getLogFilePath 带日期后缀', /zread-pi-\d{4}-\d{2}-\d{2}\.log$/.test(today));
  check('不同日期落到不同文件', today !== yesterday);
  check('getLogFile() = 今天的路径', getLogFile() === today);
  check('getLogFile() 多次调用稳定', getLogFile() === getLogFile());
  check('日志路径在隔离家目录内', today.startsWith(home));

  // 保留期清理
  const logsDir = join(home, 'logs');
  await mkdir(logsDir, { recursive: true });
  const oldName = 'zread-pi-2000-01-01.log';
  const oldFile = join(logsDir, oldName);
  const recentName = basename(today);
  const recentFile = join(logsDir, recentName);
  await writeFile(oldFile, 'old\n', 'utf-8');
  await writeFile(recentFile, 'recent\n', 'utf-8');
  const oldAge = new Date(Date.now() - (DEFAULT_LOG_RETENTION_DAYS + 10) * 86400000);
  await utimes(oldFile, oldAge, oldAge);

  check('清理删除过期文件', sweepOldLogFiles(DEFAULT_LOG_RETENTION_DAYS) === 1);
  const remaining = await readdir(logsDir);
  check('过期文件已删除', !remaining.includes(oldName), remaining.join(','));
  check('近期文件保留', remaining.includes(recentName), remaining.join(','));
  check('retention<=0 不清理', sweepOldLogFiles(0) === 0);

  // needle 兼容（命名 logger 的 info 行含 [INFO] + 消息）——文本 sink 默认关闭，显式开启
  resetLoggerServiceForTesting();
  process.env[LOG_TEXT_ENV] = '1';
  createLogger('needle-compat').info('needle-compat-4242');
  const content = await readLog();
  check('info 行含 [INFO] 与消息', content.includes('[INFO]') && content.includes('needle-compat-4242'), content.split('\n').slice(-2)[0]);
  check('行含时间戳', /\[\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d{3}\]/.test(content));

  // file exporter 记录全部级别（含 debug）
  resetLoggerServiceForTesting();
  createLogger('file-debug').debug('file-debug-line-88');
  const content2 = await readLog();
  check('file exporter 收录 debug 记录', content2.includes('file-debug-line-88'), content2.split('\n').slice(-2)[0]);
}

// ---------------------------------------------------------------------------
// ⑦ 命名 logger 端到端（名字进文件）+ 单例
// ---------------------------------------------------------------------------

{
  // 文本 sink 默认关闭，⑥⑦⑧ 段的 needle 断言需要它——显式开启
  process.env[LOG_TEXT_ENV] = '1';
  resetLoggerServiceForTesting();
  const named: Logger = createLogger('orchestrator.pages');
  named.info('named-needle-99');
  const content = await readLog();
  check('命名 logger 的名字写入文件', content.includes('orchestrator.pages'), content.split('\n').slice(-2)[0]);
  check('命名 logger 的消息写入文件', content.includes('named-needle-99'));
  check('getLoggerService 单例', getLoggerService() === getLoggerService());
  check('createLogger 缺省名 = app', createLogger().name === 'app');
}

// ---------------------------------------------------------------------------
// ⑧ 命名 logger debug + addExporter
// ---------------------------------------------------------------------------

{
  process.env[LOG_TEXT_ENV] = '1';
  resetLoggerServiceForTesting();
  createLogger('compat-markers').debug('debug-line-77');
  const content = await readLog();
  check('命名 logger debug 可用', content.includes('debug-line-77'));

  // addExporter 注册自定义 exporter（用 error 确保越过默认 INFO 阈值）
  const collected: Message[] = [];
  const dispose = addExporter({ export: (m) => collected.push(m) });
  createLogger('custom-exporter').error('via-add');
  dispose();
  createLogger('custom-exporter').error('after-dispose');
  check('addExporter 收到消息', collected.some((m) => m.args[0] === 'via-add'));
  check('注销后不再收到', !collected.some((m) => m.args[0] === 'after-dispose'));
}

// ---------------------------------------------------------------------------
// console exporter（默认不注册；渲染与 harness 一致）
// ---------------------------------------------------------------------------

{
  check('非 TTY 下 detectColorLevel = 0', detectColorLevel({ isTTY: false }) === 0);
  check('NO_COLOR 禁用（即使 TTY）', (() => {
    const saved = process.env.NO_COLOR;
    process.env.NO_COLOR = '1';
    const level = detectColorLevel({ isTTY: true });
    if (saved === undefined) delete process.env.NO_COLOR; else process.env.NO_COLOR = saved;
    return level === 0;
  })());
  check('FORCE_COLOR=3 强制 256 色（非 TTY 也生效）', (() => {
    const saved = process.env.FORCE_COLOR;
    process.env.FORCE_COLOR = '3';
    const level = detectColorLevel({ isTTY: false });
    if (saved === undefined) delete process.env.FORCE_COLOR; else process.env.FORCE_COLOR = saved;
    return level === 3;
  })());
  check('TTY + COLORTERM=truecolor → 3', (() => {
    const saved = process.env.COLORTERM;
    process.env.COLORTERM = 'truecolor';
    const level = detectColorLevel({ isTTY: true });
    if (saved === undefined) delete process.env.COLORTERM; else process.env.COLORTERM = saved;
    return level === 3;
  })());
  check('TTY + TERM 含 256 → 2', (() => {
    const saved = process.env.TERM;
    process.env.TERM = 'xterm-256color';
    const level = detectColorLevel({ isTTY: true });
    if (saved === undefined) delete process.env.TERM; else process.env.TERM = saved;
    return level === 2;
  })());

  const ce = new ConsoleExporter({ colors: false, showTime: '' });
  check('console render（无色）= [I] app hello world',
    ce.render({ sn: 1, ts: 0, name: 'app', type: 'info', level: 1, args: ['hello world'] }) === '[I] app hello world');
  const ceLabel = new ConsoleExporter({ colors: false, showTime: '', label: { width: 12, margin: 1, align: 'left' } });
  check('console render label 宽度对齐',
    ceLabel.render({ sn: 1, ts: 0, name: 'app', type: 'info', level: 1, args: ['hello'] }) === '[I] app          hello');
  const ceColor = new ConsoleExporter({ colors: 3, showTime: '' });
  check('console render（256 色）含颜色转义',
    ceColor.render({ sn: 1, ts: 0, name: 'app', type: 'info', level: 1, args: ['hi'] }) === '[I] \u001b[38;5;57;1mapp\u001b[0m hi');
  const ceColor1 = new ConsoleExporter({ colors: 1, showTime: '' });
  check('console render（16 色）丢 decoration',
    ceColor1.render({ sn: 1, ts: 0, name: 'app', type: 'info', level: 1, args: ['hi'] }) === '[I] \u001b[36mapp\u001b[0m hi');
  const ceDiff = new ConsoleExporter({ colors: false, showTime: '', showDiff: true });
  ceDiff.timestamp = 1700000000000;
  check('console render showDiff',
    ceDiff.render({ sn: 2, ts: 1700000001500, name: 'app', type: 'error', level: 0, args: ['oops'] }) === '[E] app oops +2s');
  const ceTime = new ConsoleExporter({ colors: false, showTime: 'hh:mm:ss ' });
  check('console render showTime 前缀', /^\d{2}:\d{2}:\d{2} \[I\] app hi$/.test(
    ceTime.render({ sn: 1, ts: 0, name: 'app', type: 'info', level: 1, args: ['hi'] }),
  ));
  check('console 默认 showTime 模板', new ConsoleExporter({ colors: false }).showTime === 'yyyy-MM-dd hh:mm:ss ');
  check('tui.console 记录不再回 console（防递归）', (() => {
    const saved = console.log;
    let called = false;
    console.log = () => { called = true; };
    try {
      ce.export({ sn: 1, ts: 0, name: 'tui.console', type: 'info', level: 1, args: ['captured'] });
    } finally {
      console.log = saved;
    }
    return !called;
  })());
  check('普通名字的记录正常进 console', (() => {
    const saved = console.log;
    let called = false;
    console.log = () => { called = true; };
    try {
      ce.export({ sn: 1, ts: 0, name: 'app', type: 'info', level: 1, args: ['ok'] });
    } finally {
      console.log = saved;
    }
    return called;
  })());
  check('默认不注册 console exporter（无 ZREAD_PI_LOG_CONSOLE）', (() => {
    const saved = process.env[LOG_CONSOLE_ENV];
    delete process.env[LOG_CONSOLE_ENV];
    resetLoggerServiceForTesting();
    const svc = getLoggerService();
    const has = [...svc.exporters.values()].some((e) => e instanceof ConsoleExporter);
    if (saved !== undefined) process.env[LOG_CONSOLE_ENV] = saved;
    return !has;
  })());
  check('ZREAD_PI_LOG_CONSOLE=1 时注册 console exporter', (() => {
    const saved = process.env[LOG_CONSOLE_ENV];
    process.env[LOG_CONSOLE_ENV] = '1';
    resetLoggerServiceForTesting();
    const svc = getLoggerService();
    const has = [...svc.exporters.values()].some((e) => e instanceof ConsoleExporter);
    if (saved === undefined) delete process.env[LOG_CONSOLE_ENV]; else process.env[LOG_CONSOLE_ENV] = saved;
    resetLoggerServiceForTesting();
    return has;
  })());
}

// ---------------------------------------------------------------------------
// Time 工具
// ---------------------------------------------------------------------------

{
  const fixed = new Date(2024, 0, 2, 3, 4, 5, 6);
  check('Time.template 固定本地日期', Time.template('yyyy-MM-dd hh:mm:ss.SSS', fixed) === '2024-01-02 03:04:05.006');
  check('Time.template yy 两位年份', Time.template('yy/MM/dd', fixed) === '24/01/02');
  check(
    'Time.format 档位',
    Time.format(500) === '500ms' && Time.format(1500) === '2s' && Time.format(60_000) === '1m' && Time.format(3600_000) === '1h' && Time.format(86400000 * 2) === '2d',
  );
  check('Time.format 负数档位', Time.format(-1500) === '-1s');
  check('Time.toDigits', Time.toDigits(3) === '03' && Time.toDigits(3, 3) === '003');
}

// ---------------------------------------------------------------------------
// ⑨ JSONL exporter + 审查修复回归
// ---------------------------------------------------------------------------

{
  // 9a) JSONL 默认开启 + 文本默认关闭：不设环境变量时 exporter = 缓冲 + jsonl
  resetLoggerServiceForTesting();
  delete process.env[LOG_JSONL_ENV];
  delete process.env[LOG_TEXT_ENV];
  const svc = getLoggerService();
  const names = svc.exporters.size;
  createLogger('probe.default').info('jsonl-on-probe');
  const jsonlPath = getJsonlLogFilePath();
  const existsAfterOn = await readFile(jsonlPath, 'utf-8').then(() => true, () => false);
  check('JSONL 默认开启：产出 .jsonl 文件', existsAfterOn);
  check('默认组合：exporter 数量 2（缓冲 + jsonl，文本默认关闭）', names === 2, `exporters=${names}`);
  // 早期段落（⑥ retention 测试）写过 .log 文件；先删除再验证「默认关闭不产出」
  await rm(getLogFile(), { force: true });
  createLogger('probe.text-off').info('text-off-probe');
  const textOff = await readFile(getLogFile(), 'utf-8').then(() => true, () => false);
  check('文本 sink 默认关闭：不产出 .log 文件', !textOff);

  // 9a-2) 显式开关：文本 =1 开启、jsonl =0 关闭
  resetLoggerServiceForTesting();
  process.env[LOG_TEXT_ENV] = '1';
  process.env[LOG_JSONL_ENV] = '0';
  const onSvc = getLoggerService();
  check('文本 =1 开启 / jsonl =0 关闭：exporter 数量 2（缓冲 + 文本）', onSvc.exporters.size === 2, `exporters=${onSvc.exporters.size}`);
  resetLoggerServiceForTesting();
  delete process.env[LOG_TEXT_ENV];
  delete process.env[LOG_JSONL_ENV];

  // 9b) 默认开启下：结构化行可解析、字段完整、printf 语义
  getLoggerService();
  const log = createLogger('jsonl.probe');
  log.info('hello %s', 'jsonl');
  log.warn('warn-probe');
  const raw = await readFile(jsonlPath, 'utf-8');
  const lines = raw.trim().split('\n');
  const parsed = lines.map((l) => JSON.parse(l) as Record<string, unknown>);
  // jsonl 文件从更早的段就在累积（默认开启），按名字过滤出本段的记录
  const probe = parsed.filter((r) => r.name === 'jsonl.probe');
  check('JSONL 开启：每行可 JSON.parse', probe.length >= 2);
  const first = probe[0]!;
  check(
    'JSONL 字段完整',
    typeof first.sn === 'number' &&
      typeof first.ts === 'number' && first.name === 'jsonl.probe' && first.type === 'info' &&
      typeof first.level === 'number' && first.msg === 'hello jsonl' && typeof first.time === 'string',
    JSON.stringify(first),
  );
  check('JSONL 多条记录 sn 单调递增', (probe[1]!.sn as number) > (probe[0]!.sn as number));

  // 9c) 死循环修复回归：tui.stdout 不再回到 console
  const consoleExporter = new ConsoleExporter({ colors: false });
  let consoleCalled = 0;
  const originalLog = console.log;
  console.log = () => { consoleCalled += 1; };
  try {
    consoleExporter.export({ sn: 1, ts: Date.now(), name: 'tui.stdout', type: 'info', level: 1, args: ['x'] });
    consoleExporter.export({ sn: 2, ts: Date.now(), name: 'tui.console', type: 'info', level: 1, args: ['x'] });
  } finally {
    console.log = originalLog;
  }
  check('递归保护：tui.stdout / tui.console 都不回 console', consoleCalled === 0);

  // 9d) 无参调用不抛异常 + 故障 exporter 隔离
  const noop = createLogger('noop.probe');
  noop.info();
  check('无参 logger 调用不抛异常', true);
  const explode: Exporter = { export: () => { throw new Error('boom'); } };
  const done: Exporter = { export: () => { (done as any).called = true; } };
  addExporter(explode);
  addExporter(done);
  noop.info('isolation-probe');
  check('故障 exporter 不打断广播与业务', (done as any).called === true);

  // 9e) 保留天数：负数 = 禁用清理（文档承诺），非数字回退默认
  process.env[LOG_RETENTION_DAYS_ENV] = '-1';
  const neg = new FileExporter();
  check('保留天数 -1 = 禁用清理（不回退默认 30）', (neg as any).retentionDays === -1, `retentionDays=${(neg as any).retentionDays}`);
  check('sweep(-1) 不删除任何文件', sweepOldLogFiles(-1) === 0);
  process.env[LOG_RETENTION_DAYS_ENV] = 'abc';
  const invalid = new FileExporter();
  check('保留天数非法值回退默认 30', (invalid as any).retentionDays === DEFAULT_LOG_RETENTION_DAYS);
  delete process.env[LOG_RETENTION_DAYS_ENV];
  resetLoggerServiceForTesting();
  delete process.env[LOG_JSONL_ENV];
}

// ---------------------------------------------------------------------------
// 收尾
// ---------------------------------------------------------------------------

await rm(home, { recursive: true, force: true });

const failed = checks.filter((entry) => !entry.ok);
console.log(`\n结果：${checks.length - failed.length}/${checks.length} 通过`);
if (failed.length > 0) {
  console.error('失败项：');
  for (const entry of failed) console.error(`  - ${entry.name}${entry.detail ? `\n      ${entry.detail}` : ''}`);
  process.exit(1);
}
