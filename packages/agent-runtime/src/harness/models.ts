/**
 * Models 桥：把 zread-pi 解析出的运行时模型接到 harness 的 `Models` 集合上。
 *
 * harness 的请求路径是「按 `{provider, modelId}` 经 `Models.getModel()` 重新解析模型，
 * 再调 `Models.streamSimple()`」，因此：
 *   · `getModel` 必须返回**本次运行实际解析出的模型对象**（带 baseURL / contextWindow /
 *     maxTokens 覆盖），否则配置里的覆盖项会在请求时丢失；
 *   · `streamSimple` 允许测试注入自定义 streamFn（faux provider / 请求录制），
 *     其余方法（getProviders / getAuth / refresh / ...）原样委托给底层集合，
 *     凭据解析（auth.json / OAuth）与模型目录仍然生效。
 */

import type {
	Api,
	AssistantMessageEventStream,
	Context as PiContext,
	Model,
	Models,
	SimpleStreamOptions,
} from "@earendil-works/pi-ai";

/** 与裸 loop 时期一致的 streamFn 形状（测试注入点） */
export type HarnessStreamFn = (
	model: Model<Api>,
	context: PiContext,
	options?: SimpleStreamOptions,
) => AssistantMessageEventStream;

export interface BridgeModelsOptions {
	/** 本次运行解析出的模型：`getModel(provider, id)` 命中时返回它 */
	resolved?: Model<Api>;
	/** 自定义流式入口（测试注入；生产环境由 catalog Models 承担） */
	streamSimple?: HarnessStreamFn;
}

/** 在底层 Models 集合上叠加「模型解析覆盖 + streamFn 注入」 */
export function bridgeModels(base: Models, options: BridgeModelsOptions = {}): Models {
	const { resolved, streamSimple } = options;
	if (!resolved && !streamSimple) return base;

	return new Proxy(base, {
		get(target, property, receiver) {
			if (property === "getModel" && resolved) {
				return (provider: string, id: string): Model<Api> | undefined =>
					provider === resolved.provider && id === resolved.id
						? resolved
						: target.getModel(provider, id);
			}
			if (property === "streamSimple" && streamSimple) {
				return (model: Model<Api>, context: PiContext, opts?: SimpleStreamOptions) =>
					streamSimple(model, context, opts);
			}
			const value = Reflect.get(target, property, receiver) as unknown;
			return typeof value === "function" ? (value as (...args: unknown[]) => unknown).bind(target) : value;
		},
	}) as Models;
}
