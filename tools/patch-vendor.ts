/**
 * patch-vendor.ts
 *
 * 把 vendor/pi/packages/* 的 package.json 从"dist 产物导出"改写为"src 源码导出"，
 * 使本仓库无需先构建 pi 即可：
 *   - 用 Bun 直接运行 TypeScript 源码（Bun 原生支持 .ts）
 *   - 用 tsc 解析类型（moduleResolution: bundler 会读取 exports）
 *
 * 同时剥离 devDependencies / scripts / bin / files，避免安装期拉入
 * canvas、vitest、aws-sdk 之外的构建工具等无关依赖。
 *
 * 运行：bun run tools/patch-vendor.ts
 */

import { readdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";

const VENDOR_ROOT = join(import.meta.dir, "..", "vendor", "pi", "packages");

/** ./dist/foo/bar.js -> ./src/foo/bar.ts */
function toSourcePath(distPath: string): string {
	return distPath.replace(/^\.\/dist\//, "./src/").replace(/\.d\.ts$/, ".ts").replace(/\.js$/, ".ts");
}

function rewriteExportValue(value: unknown): unknown {
	if (typeof value === "string") return toSourcePath(value);
	if (Array.isArray(value)) return value.map(rewriteExportValue);
	if (value && typeof value === "object") {
		const out: Record<string, unknown> = {};
		for (const [key, inner] of Object.entries(value as Record<string, unknown>)) {
			// types / import / source / default 等条件都指向同一个 .ts 源码
			out[key] = typeof inner === "string" ? toSourcePath(inner) : rewriteExportValue(inner);
		}
		return out;
	}
	return value;
}

const report: string[] = [];

for (const entry of readdirSync(VENDOR_ROOT, { withFileTypes: true })) {
	if (!entry.isDirectory()) continue;
	const pkgPath = join(VENDOR_ROOT, entry.name, "package.json");
	if (!existsSync(pkgPath)) continue;

	const pkg = JSON.parse(readFileSync(pkgPath, "utf8")) as Record<string, any>;

	// 1) exports -> src/*.ts
	const exportsField: Record<string, unknown> = {};
	for (const [subpath, value] of Object.entries(pkg.exports ?? {})) {
		exportsField[subpath] = rewriteExportValue(value);
	}
	pkg.exports = exportsField;

	// 2) main / types 指向源码入口
	pkg.main = "./src/index.ts";
	pkg.types = "./src/index.ts";

	// 3) 清掉发布/构建相关字段
	delete pkg.bin;
	delete pkg.files;
	delete pkg.scripts;
	delete pkg.devDependencies;
	delete pkg.overrides;
	delete pkg.prepublishOnly;

	// 4) 标记为 vendored，避免误发布
	pkg.private = true;

	writeFileSync(pkgPath, `${JSON.stringify(pkg, null, "\t")}\n`, "utf8");
	report.push(`${pkg.name}: exports=${Object.keys(exportsField).length}, deps=${Object.keys(pkg.dependencies ?? {}).length}`);
}

console.log("patched vendored pi packages:");
for (const line of report) console.log(`  - ${line}`);
