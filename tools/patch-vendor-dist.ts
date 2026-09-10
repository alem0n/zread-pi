/**
 * patch-vendor-dist.ts
 *
 * 把 vendor/pi/packages/* 的 package.json 从"src 源码导出"切回"消费 dist 产物"模式：
 *   main / types / exports 里的 ./src/**.ts → ./dist/**.js | ./dist/**.d.ts
 *
 * 与 patch-vendor.ts（切到 src 模式）互逆，且**不依赖 archive/**，可独立使用。
 * 切换后需要构建产物：bun run vendor:build
 *
 * 运行：bun run vendor:dist
 */

import { readdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";

const VENDOR_ROOT = join(import.meta.dir, "..", "vendor", "pi", "packages");

/** ./src/foo/bar.ts -> ./dist/foo/bar.js   或   ./dist/foo/bar.d.ts */
function toDistPath(sourcePath: string, kind: "types" | "runtime"): string {
	const withoutPrefix = sourcePath.replace(/^\.\/src\//, "");
	const withoutExtension = withoutPrefix.replace(/\.ts$/, "");
	// 通配符条目（如 ./src/providers/*.ts）保留通配
	return `./dist/${withoutExtension}.${kind === "types" ? "d.ts" : "js"}`;
}

function rewriteEntry(entry: unknown, kind: "types" | "runtime"): unknown {
	if (typeof entry === "string") return toDistPath(entry, kind);
	if (entry && typeof entry === "object") {
		const out: Record<string, unknown> = {};
		for (const [condition, value] of Object.entries(entry as Record<string, unknown>)) {
			out[condition] = rewriteEntry(value, condition === "types" ? "types" : "runtime");
		}
		return out;
	}
	return entry;
}

const report: string[] = [];

for (const entry of readdirSync(VENDOR_ROOT, { withFileTypes: true })) {
	if (!entry.isDirectory()) continue;
	const pkgPath = join(VENDOR_ROOT, entry.name, "package.json");
	if (!existsSync(pkgPath)) continue;

	const pkg = JSON.parse(readFileSync(pkgPath, "utf8")) as Record<string, any>;
	if (typeof pkg.main !== "string" || !pkg.main.startsWith("./src/")) {
		report.push(`${pkg.name}: 已是 dist 模式，跳过`);
		continue;
	}

	pkg.main = toDistPath(pkg.main, "runtime");
	pkg.types = toDistPath(pkg.types ?? pkg.main, "types");

	const exportsField: Record<string, unknown> = {};
	for (const [subpath, value] of Object.entries(pkg.exports ?? {})) {
		exportsField[subpath] = subpath === "./package.json" ? value : rewriteEntry(value, "runtime");
	}
	pkg.exports = exportsField;

	writeFileSync(pkgPath, `${JSON.stringify(pkg, null, "\t")}\n`, "utf8");
	report.push(`${pkg.name}: exports=${Object.keys(exportsField).length}（dist 模式）`);
}

console.log("switched vendored pi packages to dist mode:");
for (const line of report) console.log(`  - ${line}`);
console.log("\n如需重新生成产物：bun run vendor:build");
