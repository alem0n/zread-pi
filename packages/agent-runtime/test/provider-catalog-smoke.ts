/**
 * provider-catalog-smoke.ts —— pi-ai Provider 目录 / 登录 / 自定义模型 冒烟测试
 *
 * 覆盖：
 *  1. 列出 pi-ai 内置 Provider（含 OAuth / API Key 登录能力）
 *  2. login（api_key）写入 ~/.zread-pi/auth.json，checkAuth 立即变为已配置
 *  3. 同时登录多个 Provider（互不覆盖）
 *  4. 为指定 Provider 添加自定义模型（models.json 合并语义）并出现在模型列表
 *  5. 未内置的自定义 Provider（openai-compatible 端点）可被注册
 *  6. createRuntimeModel 走 catalog（真实模型元数据），logout 只影响目标 Provider
 *
 * 运行：bun run test:catalog（离线，无需 API Key）
 */

import { mkdtemp, readFile, rm, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "@zread-pi/utils";
import {
	createRuntimeModel,
	getZreadModel,
	getZreadProviderModels,
	getZreadThinkingLevels,
	hasZreadProvider,
	listZreadProviders,
	loginZreadProvider,
	logoutZreadProvider,
	refreshZreadProviderModels,
	setZreadCatalogConfig,
} from "../src/index.js";

const checks: Array<{ name: string; ok: boolean; detail?: string }> = [];
function check(name: string, ok: boolean, detail?: string): void {
	checks.push({ name, ok, detail });
	console.log(`${ok ? "  ✅" : "  ❌"} ${name}${detail ? ` — ${detail}` : ""}`);
}

const home = await mkdtemp(join(tmpdir(), "zread-pi-catalog-home-"));
process.env.HOME = home;
process.env.USERPROFILE = home;
// 避免宿主环境变量把「未配置」判定污染
delete process.env.ANTHROPIC_API_KEY;
delete process.env.OPENAI_API_KEY;

const authPath = join(home, ".zread-pi", "auth.json");
await mkdir(join(home, ".zread-pi"), { recursive: true });

/** 重写 home 下的 config.yaml（用于验证 agent 段的归一化语义） */
async function writeHomeConfig(agentLines: string[]): Promise<void> {
	await writeFile(
		join(home, ".zread-pi", "config.yaml"),
		[
			"language: zh",
			"doc_language: zh",
			"llm:",
			"  provider: null",
			"  model: null",
			"  api_key: null",
			"  base_url: null",
			"  providers: {}",
			...agentLines,
			"concurrency:",
			"  max_concurrent: 1",
			"  max_retries: 0",
			"",
		].join("\n"),
		"utf-8",
	);
}
await writeFile(
	join(home, ".zread-pi", "config.yaml"),
	[
		"language: zh",
		"doc_language: zh",
		"llm:",
		"  provider: null",
		"  model: null",
		"  api_key: null",
		"  base_url: null",
		"  providers: {}",
		"concurrency:",
		"  max_concurrent: 1",
		"  max_retries: 0",
		"",
	].join("\n"),
	"utf-8",
);

try {
	// ---- 1) 内置 Provider 列表 ----
	const loadedConfig = await loadConfig();
	check(
		"旧 config.yaml（缺 agent 段）补默认 max_turns=30",
		loadedConfig.agent.max_turns === 30,
		JSON.stringify(loadedConfig.agent),
	);

	// max_turns 归一化：0 = 不限制轮次（保留 0，不回退默认值）；负数非法，回退默认 30
	await writeHomeConfig(["agent:", "  max_turns: 0"]);
	const zeroTurnsConfig = await loadConfig();
	check(
		"agent.max_turns: 0 保留为 0（0 = 不限制轮次，不回退 30）",
		zeroTurnsConfig.agent.max_turns === 0,
		JSON.stringify(zeroTurnsConfig.agent),
	);

	await writeHomeConfig(["agent:", "  max_turns: -1"]);
	const negativeTurnsConfig = await loadConfig();
	check(
		"agent.max_turns 为负数时回退默认 30",
		negativeTurnsConfig.agent.max_turns === 30,
		JSON.stringify(negativeTurnsConfig.agent),
	);

	const providers = await listZreadProviders();
	const anthropic = providers.find((provider) => provider.id === "anthropic");
	check("内置 Provider 数量 >= 30", providers.length >= 30, `count=${providers.length}`);
	check(
		"anthropic 有内置模型目录",
		Boolean(anthropic && anthropic.modelCount > 0),
		`models=${anthropic?.modelCount}`,
	);
	check("anthropic 支持 OAuth 登录", anthropic?.hasOAuth === true);
	check("anthropic 初始为未配置", anthropic?.configured === false, JSON.stringify(anthropic));

	const openai = providers.find((provider) => provider.id === "openai");
	check("openai 在列表中且支持 API Key 登录", Boolean(openai?.hasApiKeyAuth), `models=${openai?.modelCount}`);

	// ---- 2) api_key 登录 ----
	const credential = await loginZreadProvider("anthropic", "api_key", {
		prompt: async () => "sk-ant-test-key",
		notify: () => {},
	});
	check("login 返回 api_key 凭据", credential.type === "api_key", JSON.stringify(credential));

	const authFile = JSON.parse(await readFile(authPath, "utf-8")) as Record<string, { type: string; key?: string }>;
	check(
		"凭据落盘到 ~/.zread-pi/auth.json",
		authFile.anthropic?.type === "api_key" && authFile.anthropic.key === "sk-ant-test-key",
		JSON.stringify(authFile),
	);

	const afterLogin = (await listZreadProviders()).find((provider) => provider.id === "anthropic");
	check(
		"登录后 anthropic 显示已配置 (api_key)",
		afterLogin?.configured === true && afterLogin.authType === "api_key",
		JSON.stringify(afterLogin),
	);

	// ---- 3) 同时配置多个 Provider ----
	await loginZreadProvider("openai", "api_key", {
		prompt: async () => "sk-openai-test-key",
		notify: () => {},
	});
	const multi = await listZreadProviders();
	const configuredIds = multi.filter((provider) => provider.configured).map((provider) => provider.id);
	check(
		"多个 Provider 可同时配置",
		configuredIds.includes("anthropic") && configuredIds.includes("openai"),
		configuredIds.join(","),
	);
	check(
		"auth.json 同时保存两个 Provider",
		Object.keys(JSON.parse(await readFile(authPath, "utf-8"))).sort().join(",") === "anthropic,openai",
	);
	const openaiSummary = multi.find((provider) => provider.id === "openai");
	check("openai 未被 anthropic 凭据覆盖", openaiSummary?.configured === true, JSON.stringify(openaiSummary));

	// ---- 4) 自定义模型（追加 + 覆盖） ----
	const baseConfig = {
		language: "zh",
		doc_language: "zh",
		llm: {
			provider: null as string | null,
			model: null as string | null,
			api_key: null as string | null,
			base_url: null as string | null,
			thinking_level: "off" as const,
			providers: {
				anthropic: {
					auth_type: "api_key" as const,
					base_url: null as string | null,
					api: null as string | null,
					model: "my-local-model" as string | null,
					models: [
						{
							id: "my-local-model",
							name: "My Local Model",
							context_window: 123456,
							max_tokens: 777,
							reasoning: true,
							supports_vision: true,
						},
					],
				},
			},
		},
		agent: { max_turns: 30 },
		concurrency: { max_concurrent: 1, max_retries: 0 },
	};
	setZreadCatalogConfig(baseConfig);

	const models = getZreadProviderModels("anthropic");
	const custom = models.find((model) => model.id === "my-local-model");
	check("自定义模型出现在 provider 模型列表", Boolean(custom), `total=${models.length}`);
	check(
		"自定义模型元数据生效",
		custom?.contextWindow === 123456 && custom?.maxTokens === 777 && custom?.reasoning === true,
		JSON.stringify(custom && { cw: custom.contextWindow, mt: custom.maxTokens, reasoning: custom.reasoning }),
	);
	check("自定义模型支持图片输入", custom?.input.includes("image") === true, JSON.stringify(custom?.input));
	check("getZreadModel 能查到自定义模型", getZreadModel("anthropic", "my-local-model")?.id === "my-local-model");

	// ---- 5) 未内置的自定义 Provider ----
	const customProviderConfig = {
		...baseConfig,
		llm: {
			...baseConfig.llm,
			providers: {
				...baseConfig.llm.providers,
				"my-endpoint": {
					auth_type: "api_key" as const,
					base_url: "http://127.0.0.1:9/v1",
					api: "openai-completions",
					model: "m1",
					models: [{ id: "m1", name: "M One", context_window: 8000, max_tokens: 1000 }],
				},
			},
		},
	};
	setZreadCatalogConfig(customProviderConfig);
	check("未内置 Provider 被注册", hasZreadProvider("my-endpoint"));
	check(
		"未内置 Provider 的模型可见",
		getZreadProviderModels("my-endpoint").some((model) => model.id === "m1"),
	);
	const endpointSummary = (await listZreadProviders()).find((provider) => provider.id === "my-endpoint");
	check("未内置 Provider 标记为非内置", endpointSummary?.builtin === false, JSON.stringify(endpointSummary));

	// ---- 6) runtime model 走 catalog ----
	const runtime = createRuntimeModel({ providerId: "anthropic", modelId: "my-local-model" });
	check("createRuntimeModel 命中 catalog", runtime.providerId === "anthropic" && runtime.model.id === "my-local-model");
	check(
		"catalog 模型保留真实窗口/输出上限",
		runtime.model.contextWindow === 123456 && runtime.model.maxTokens === 777,
		`${runtime.model.contextWindow}/${runtime.model.maxTokens}`,
	);

	const realRuntime = createRuntimeModel({ providerId: "anthropic", modelId: "claude-sonnet-4-5" });
	check(
		"内置模型解析出 pi 目录元数据",
		realRuntime.model.contextWindow > 100000,
		`${realRuntime.model.id} cw=${realRuntime.model.contextWindow}`,
	);
	check(
		"内置模型带真实成本表",
		realRuntime.model.cost.input >= 0 && typeof realRuntime.model.cost.input === "number",
		JSON.stringify(realRuntime.model.cost),
	);

	// ---- 6b) 思考深度（pi thinking level）的受支持等级 ----
	check(
		"未选择模型时返回 pi 的全部思考等级",
		getZreadThinkingLevels(null, null).join(",") === "off,minimal,low,medium,high,xhigh,max",
		getZreadThinkingLevels(null, null).join(","),
	);
	check(
		"目录外的模型按全部等级处理（由 pi 在请求时调整）",
		getZreadThinkingLevels("anthropic", "not-in-catalog").length === 7,
		getZreadThinkingLevels("anthropic", "not-in-catalog").join(","),
	);
	check(
		"不支持思考的模型仅提供 off",
		getZreadThinkingLevels("my-endpoint", "m1").join(",") === "off",
		getZreadThinkingLevels("my-endpoint", "m1").join(","),
	);
	const sonnetLevels = getZreadThinkingLevels("anthropic", "claude-sonnet-4-5");
	check(
		"内置模型返回 pi 声明的等级（无 xhigh/max）",
		sonnetLevels.join(",") === "off,minimal,low,medium,high",
		sonnetLevels.join(","),
	);
	const opusLevels = getZreadThinkingLevels("anthropic", "claude-opus-4-6");
	check(
		"thinkingLevelMap 声明的 max 出现在支持列表",
		opusLevels.includes("max"),
		opusLevels.join(","),
	);
	check(
		"自定义思考模型（未声明 xhigh/max）返回 off..high",
		getZreadThinkingLevels("anthropic", "my-local-model").join(",") === "off,minimal,low,medium,high",
		getZreadThinkingLevels("anthropic", "my-local-model").join(","),
	);

	// 静态 Provider 刷新不报错（pi 会跳过静态目录）
	const refreshStatic = await refreshZreadProviderModels("anthropic");
	check("静态 Provider 刷新返回成功", refreshStatic.ok === true, JSON.stringify(refreshStatic));

	// ---- 7) logout 只影响目标 Provider ----
	await logoutZreadProvider("anthropic");
	const afterLogout = await listZreadProviders();
	check(
		"logout 后 anthropic 未配置",
		afterLogout.find((provider) => provider.id === "anthropic")?.configured === false,
	);
	check(
		"logout 不影响 openai",
		afterLogout.find((provider) => provider.id === "openai")?.configured === true,
	);

	const failures = checks.filter((entry) => !entry.ok);
	console.log(`\n结果：${checks.length - failures.length}/${checks.length} 通过`);
	if (failures.length > 0) {
		console.error(`失败项：${failures.map((entry) => entry.name).join("; ")}`);
		process.exitCode = 1;
	}
} finally {
	setZreadCatalogConfig(undefined);
	await rm(home, { recursive: true, force: true });
}
