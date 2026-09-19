/**
 * 黄金值对照 —— plan.md §5.5 的一致性校验（强制项）
 *
 * 用**同一输入**在 lecture-to-notes 的 Python 参考实现与 zread-pi 的 TS 实现上
 * 跑出计数，断言判定结果一致。任一「保留语义」被改动、或阈值漂移 → 本测试 FAIL。
 *
 * 黄金值由 `tools/golden-parity-gen.py` 生成（调用源仓库的
 * verify_notes.CJK / extract_claims.numbers_in / flatten_tex）：
 *   python3 tools/golden-parity-gen.py
 * 样本 SAMPLES 与该脚本逐字一致；改动样本必须两边同步并重新生成黄金值。
 *
 * 有意偏差（不在本测试对照范围，已在 MIGRATION §29 / §31 声明）：
 * - Python 的 CJK 门基于视频时长；zread-pi 基于 level + 关联文件规模（§0.2 不照搬公式）；
 * - Python 在 LaTeX 上计数；zread-pi 在 Markdown 上剥离围栏后计数（§3.1）。
 *   本测试只对照**字符级正则语义**（哪些字符算 CJK / 哪些串算数字），
 *   这正是「判定逻辑」本身，是 §5.5 要求不得漂移的部分。
 *
 * 运行：bun run packages/orchestrator/test/golden-parity.ts
 */

import { countCjkChars, numbersIn } from '../src/wiki/content-gate.js';

const checks: Array<{ name: string; ok: boolean; detail?: string }> = [];
function check(name: string, ok: boolean, detail?: string): void {
	checks.push({ name, ok, detail });
	console.log(`${ok ? '  ✅' : '  ❌'} ${name}${detail ? ` — ${detail}` : ''}`);
}

// 与 tools/golden-parity-gen.py 的 SAMPLES 逐字一致（改动须两边同步）
const SAMPLES: Record<string, string> = {
	s1_pure_ascii: 'Hello world 42',
	s2_pure_cjk: '读者优先写作纪律',
	s3_mixed: 'Agent 封装了用户意图，协调 AI 与设备操作',
	s4_ext_bmp: '𠀀 罕见扩展区汉字',
	s5_emoji_punct: '🎉 重要提示：100%',
	s6_code_like: "const x = createAgent({ model: 'gpt' });  // 创建 Agent",
};

// 由 tools/golden-parity-gen.py 在源 Python 实现上跑出的黄金值（2026-09 标定）
const GOLDEN_CJK: Record<string, number> = {
	s1_pure_ascii: 0,
	s2_pure_cjk: 8,
	s3_mixed: 14,
	s4_ext_bmp: 7, // 𠀀 属 CJK 扩展 B（U+20000+），不在 [一-鿿] 内，源实现同样不计
	s5_emoji_punct: 4,
	s6_code_like: 2,
};

console.log('\n▶ A. CJK 字符计数：TS 实现与 Python verify_notes.CJK 同输入一致');

for (const [key, text] of Object.entries(SAMPLES)) {
	const ts = countCjkChars(text);
	const py = GOLDEN_CJK[key];
	check(
		`CJK 计数一致：${key}`,
		ts === py,
		`ts=${ts} python=${py}（文本：${text.slice(0, 18)}${text.length > 18 ? '…' : ''}）`,
	);
}

console.log('\n▶ B. 数字台账口径：TS numbersIn 与 Python numbers_in 同输入一致');

{
	// Python flatten_tex 的输出「裸文本100percent与x2公式enddocument」→ numbers_in = ["100", "2"]
	const flattened = '裸文本100percent与x2公式enddocument';
	const tsNumbers = numbersIn(flattened);
	const pyNumbers = ['100', '2'];
	check(
		'剥离后数字串一致（["100","2"]）',
		JSON.stringify(tsNumbers) === JSON.stringify(pyNumbers),
		`ts=${JSON.stringify(tsNumbers)}`,
	);

	// 语义保真：千分位逗号续接为一段（不是两个数字），小数点同理
	check('千分位逗号续接为一段', JSON.stringify(numbersIn('共有 1,234 行')) === JSON.stringify(['1,234']));
	check('小数点续接为一段', JSON.stringify(numbersIn('耗时 1.5 秒')) === JSON.stringify(['1.5']));
	check('无数字时返回空数组', numbersIn('没有数字').length === 0);
}

console.log('\n▶ C. 边界语义（与源实现同一行为）');

{
	// U+4E00 与 U+9FFF 恰好在区间端点（闭区间，源正则 [一-鿿] 同样含端点）
	check('U+4E00「一」计入', countCjkChars('一') === 1);
	check('U+9FFF「鿿」计入', countCjkChars('鿿') === 1);
	// 紧邻区间外的不计（源实现的 CJK 正则只覆盖基本区）
	check('U+3000「　」全角空格不计入', countCjkChars('　') === 0);
	check('U+FF0C「，」全角逗号不计入', countCjkChars('，') === 0);
	// 空串
	check('空串计数为 0', countCjkChars('') === 0);
}

// ==================== 汇总 ====================

console.log('');
const failed = checks.filter((c) => !c.ok);
if (failed.length > 0) {
	console.log(`❌ ${failed.length} 项失败（判定语义与 Python 参考实现漂移，见 §5.5）：`);
	for (const c of failed) console.log(`  - ${c.name}${c.detail ? ` — ${c.detail}` : ''}`);
	process.exitCode = 1;
}
console.log(`结果：${checks.length - failed.length}/${checks.length} 通过`);
