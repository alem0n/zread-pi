/**
 * debug-events.ts —— 探查 pi 事件与适配层映射（仅用于排障）
 * 运行：bun run packages/agent-runtime/test/debug-events.ts
 */

import { createModels } from "@earendil-works/pi-ai";
import { fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai/providers/faux";
import { createAgent } from "../src/index.js";

const faux = fauxProvider({ tokensPerSecond: 0 });
const models = createModels();
models.setProvider(faux.provider);
const model = faux.models[0];

faux.setResponses([
	fauxAssistantMessage("", { stopReason: "error", errorMessage: "429 rate limit exceeded" }),
	fauxAssistantMessage("重试后成功"),
]);

console.log("--- 直接观察 pi Models.streamSimple 的事件 ---");
const stream = models.streamSimple(model, { systemPrompt: "s", messages: [{ role: "user", content: "hi", timestamp: Date.now() }] });
for await (const event of stream) {
	console.log("  pi event:", event.type, event.type === "error" ? `reason=${event.reason} err=${event.error.errorMessage}` : "");
}
console.log("  pi final:", JSON.stringify(await stream.result()).slice(0, 200));

console.log("\n--- 经适配层 createAgent.query() ---");
const agent = createAgent({
	model: "faux-model",
	systemPrompt: "s",
	maxTurns: 3,
	tools: [],
	runtimeOverride: { model, streamFn: (m, c, o) => models.streamSimple(m, c, o) },
	retryConfig: {
		maxRetries: 2,
		baseDelayMs: 5,
		maxDelayMs: 5,
		retryableStatusCodes: [429],
		onRetry: (info) => console.log("  [onRetry]", JSON.stringify(info)),
	},
});

for await (const event of agent.query("hi")) {
	console.log("  sdk:", JSON.stringify(event).slice(0, 300));
}
