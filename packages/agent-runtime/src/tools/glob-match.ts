/**
 * glob 匹配（与 fd `--glob` 语义对齐）
 *
 * 为什么自研而不用 npm 包：`Glob` / `Grep` 两条执行路径（fd/rg 与纯 JS 兜底）
 * 必须给出**同一套匹配语义**，而 fd 的 `--glob` 语义（无 `/` 的 pattern 匹配 basename，
 * 有 `/` 的 pattern 匹配完整路径并隐式前置 `**` `/`）没有现成的轻量实现。
 * 这里用 ~100 行实现该语义，避免引入仅单平台可用的依赖，同时保持可测试。
 *
 * 支持：`*`、`**`、`?`、`[...]`（含 `!`/`^` 取反）、`{a,b}`（可嵌套）、`\` 转义。
 * 分隔符统一按 `/` 处理，调用方负责把 Windows 的 `\` 归一化。
 */

const REGEXP_SPECIALS = /[\\^$.|+()[\]]/;

function escapeRegExpChar(char: string): string {
	return REGEXP_SPECIALS.test(char) ? `\\${char}` : char;
}

/** 展开 `{a,b}` 花括号（支持嵌套）；没有花括号时返回原 pattern。 */
export function expandBraces(pattern: string): string[] {
	const open = findUnescaped(pattern, "{", 0);
	if (open === -1) return [pattern];
	const close = findMatchingBrace(pattern, open);
	if (close === -1) return [pattern];

	const prefix = pattern.slice(0, open);
	const suffix = pattern.slice(close + 1);
	const body = pattern.slice(open + 1, close);
	const alternatives = splitTopLevel(body);

	const results: string[] = [];
	for (const alternative of alternatives) {
		for (const expanded of expandBraces(prefix + alternative + suffix)) {
			results.push(expanded);
		}
	}
	return results;
}

function findUnescaped(text: string, char: string, from: number): number {
	for (let index = from; index < text.length; index++) {
		if (text[index] === "\\") {
			index++;
			continue;
		}
		if (text[index] === char) return index;
	}
	return -1;
}

function findMatchingBrace(text: string, open: number): number {
	let depth = 0;
	for (let index = open; index < text.length; index++) {
		if (text[index] === "\\") {
			index++;
			continue;
		}
		if (text[index] === "{") depth++;
		else if (text[index] === "}") {
			depth--;
			if (depth === 0) return index;
		}
	}
	return -1;
}

function splitTopLevel(body: string): string[] {
	const parts: string[] = [];
	let depth = 0;
	let current = "";
	for (let index = 0; index < body.length; index++) {
		const char = body[index];
		if (char === "\\") {
			current += char;
			if (index + 1 < body.length) {
				current += body[index + 1];
				index++;
			}
			continue;
		}
		if (char === "{") depth++;
		else if (char === "}") depth--;
		if (char === "," && depth === 0) {
			parts.push(current);
			current = "";
			continue;
		}
		current += char;
	}
	parts.push(current);
	return parts;
}

function compileSegmentSource(pattern: string): string {
	let source = "";
	let index = 0;
	while (index < pattern.length) {
		const char = pattern[index];

		if (char === "\\") {
			const next = pattern[index + 1];
			if (next !== undefined) {
				source += escapeRegExpChar(next);
				index += 2;
				continue;
			}
			source += "\\\\";
			index++;
			continue;
		}

		if (char === "*") {
			let stars = 0;
			while (pattern[index] === "*") {
				stars++;
				index++;
			}
			if (stars >= 2) {
				if (pattern[index] === "/") {
					// `**/` 匹配零个或多个路径段（`a/**/b` 命中 `a/b` 与 `a/x/y/b`）
					index++;
					source += "(?:[^/]+/)*";
				} else {
					// 末尾 `**` 匹配任意剩余路径（含分隔符）
					source += ".*";
				}
			} else {
				source += "[^/]*";
			}
			continue;
		}

		if (char === "?") {
			source += "[^/]";
			index++;
			continue;
		}

		if (char === "[") {
			const parsed = parseCharacterClass(pattern, index);
			if (parsed) {
				source += parsed.source;
				index = parsed.next;
				continue;
			}
			source += "\\[";
			index++;
			continue;
		}

		if (char === "{") {
			// 未被 expandBraces 处理的花括号（不成对等）：按字面量处理
			source += "\\{";
			index++;
			continue;
		}

		source += escapeRegExpChar(char);
		index++;
	}
	return source;
}

function parseCharacterClass(pattern: string, start: number): { source: string; next: number } | undefined {
	let index = start + 1;
	if (index >= pattern.length) return undefined;

	let negated = false;
	if (pattern[index] === "!" || pattern[index] === "^") {
		negated = true;
		index++;
	}

	let body = "";
	let closed = false;
	while (index < pattern.length) {
		const char = pattern[index];
		if (char === "]" && body.length > 0) {
			closed = true;
			index++;
			break;
		}
		if (char === "\\" && index + 1 < pattern.length) {
			body += `\\${pattern[index + 1]}`;
			index += 2;
			continue;
		}
		if (char === "^" || char === "]") {
			body += `\\${char}`;
			index++;
			continue;
		}
		body += char;
		index++;
	}
	if (!closed) return undefined;

	return { source: `[${negated ? "^/" : ""}${body}]`, next: index };
}

/** 把单个 glob pattern 编译成锚定的 RegExp（`/` 为路径分隔符）。 */
export function globToRegExp(pattern: string): RegExp {
	const alternatives = expandBraces(pattern).map(compileSegmentSource);
	return new RegExp(`^(?:${alternatives.join("|")})$`);
}

/**
 * 按 fd `--glob` 语义测试一个**相对路径**：
 *  - pattern 不含 `/`：匹配 basename（fd 默认行为，即 `*.ts` 能命中 `src/a.ts`）
 *  - pattern 含 `/`：匹配完整相对路径，且非绝对/非 `**` `/` 前缀时隐式前置 `**` `/`
 *    （对应 fd 的 `--full-path` + 上游的 `**` `/` 补全逻辑）
 */
export function matchGlobPath(relativePath: string, pattern: string): boolean {
	const candidate = relativePath.split(/[\\/]/).join("/");
	const normalizedPattern = pattern.replace(/\\/g, "/");

	if (!normalizedPattern.includes("/")) {
		const base = candidate.slice(candidate.lastIndexOf("/") + 1);
		return globToRegExp(normalizedPattern).test(base);
	}

	let effective = normalizedPattern;
	if (!effective.startsWith("/") && !effective.startsWith("**/") && effective !== "**") {
		effective = `**/${effective}`;
	}
	const rootAnchored = effective.startsWith("/");
	const body = rootAnchored ? effective.slice(1) : effective;
	return globToRegExp(body).test(candidate);
}
