/**
 * Config Auth Page - Provider 登录页（pi-ai login / OAuth / API Key）
 *
 * 路由：/config/provider/:providerId/model/:modelId
 *
 * 行为：
 * - 未配置凭据：走 pi-ai 的 login 流程
 *     · Provider 同时提供 OAuth 与 API Key 时先选择登录方式
 *     · 登录过程中的 prompt（text/secret/select/manual_code）与 notify
 *       （auth_url / device_code / info / progress）直接渲染在本页
 * - 已配置凭据：enter 直接把该模型设为当前模型；l 重新登录；d 退出登录
 *
 * 凭据由 pi-ai 的 Models.login 写入 ~/.zread/auth.json（可同时保存多个 Provider）。
 */

import { matchesKey, visibleWidth } from "@earendil-works/pi-tui";
import {
  getZreadCatalog,
  getZreadModel,
  getZreadProvider,
  loginZreadProvider,
  logoutZreadProvider,
  setZreadCatalogConfig,
} from "@open-zread/agent-runtime";
import { TextField } from "../../tui/components/text-field";
import { barIndicator } from "../../tui/components/select";
import { style } from "../../tui/ansi";
import { Screen } from "../../tui/screen";
import { clampLine } from "../../tui/text-layout";
import { migrateLegacyCredentials } from "../../utils/llm-config";

type AuthType = "api_key" | "oauth";

type PageState = "loading" | "choose" | "prompt" | "running" | "configured" | "error";

interface AuthPromptLike {
  type: "text" | "secret" | "select" | "manual_code";
  message: string;
  placeholder?: string;
  options?: readonly { id: string; label: string; description?: string }[];
  signal?: AbortSignal;
}

interface AuthEventLike {
  type: "info" | "auth_url" | "device_code" | "progress";
  message?: string;
  url?: string;
  instructions?: string;
  userCode?: string;
  verificationUri?: string;
}

export default class ConfigAuthPage extends Screen {
  private providerId = "";
  private modelId = "";
  private providerName = "";
  private configured = false;
  private configuredType: AuthType | null = null;
  private configuredSource = "";
  private hasOAuth = false;
  private hasApiKey = false;
  private oauthLabel = "";

  private state: PageState = "loading";
  private selectedIndex = 0;
  private error: string | null = null;
  private infoLines: string[] = [];
  private promptMessage = "";
  private promptType: AuthPromptLike["type"] = "text";
  private promptField = new TextField();
  private promptResolve: ((value: string) => void) | null = null;
  private promptReject: ((error: Error) => void) | null = null;
  private loginController: AbortController | null = null;

  protected override init(): void {
    const params = this.app.location?.params ?? {};
    this.providerId = params.providerId ?? "";
    this.modelId = params.modelId ? decodeURIComponent(params.modelId) : "";
    this.app.claimEsc();
    // 让 catalog 使用 CLI 内存配置（未保存的修改也能反映到模型/登录判断）
    setZreadCatalogConfig(this.app.config.config);

    this.promptField.onSubmit = () => this.submitPrompt(this.promptField.getValue());
    void this.load();
  }

  override handleKey(data: string): boolean {
    if (matchesKey(data, "escape")) {
      this.handleBack();
      return true;
    }

    if (this.state === "choose") {
      return this.handleChoiceKey(data);
    }

    if (this.state === "prompt") {
      if (this.isSelectPrompt) {
        const options = this.promptSelectOptions;
        if (matchesKey(data, "up") || data === "k") {
          this.selectedIndex = Math.max(0, this.selectedIndex - 1);
          this.refresh();
          return true;
        }
        if (matchesKey(data, "down") || data === "j") {
          this.selectedIndex = Math.min(options.length - 1, this.selectedIndex + 1);
          this.refresh();
          return true;
        }
        if (matchesKey(data, "return")) {
          const selected = options[this.selectedIndex];
          if (selected) this.submitPrompt(selected.id);
          return true;
        }
        return true;
      }
      this.promptField.handleKey(data);
      return true;
    }

    if (this.state === "running") {
      return true;
    }

    if (this.state === "configured") {
      if (matchesKey(data, "return")) {
        void this.useModel();
        return true;
      }
      if (data === "l") {
        this.beginChoose();
        return true;
      }
      if (data === "d") {
        void this.logout();
        return true;
      }
    }

    return true;
  }

  override onDestroy(): void {
    this.abortLogin();
    this.app.releaseEsc();
  }

  render(width: number): string[] {
    const lines: string[] = [];

    lines.push(
      "",
      clampLine(
        style(this.providerName || this.providerId, { bold: true, color: "cyan" }) +
          style(` · ${this.modelId}`, { color: "white" }),
        width,
      ),
    );

    // 凭据状态（marginTop={1}）
    lines.push(
      "",
      this.configured
        ? style(
            `✓ ${this.t("provider.configured")}${
              this.configuredType ? ` · ${this.authTypeLabel(this.configuredType)}` : ""
            }${this.configuredSource ? ` · ${this.t("provider.source", { source: this.configuredSource })}` : ""}`,
            { color: "green" },
          )
        : style(`○ ${this.t("provider.notConfigured")}`, { color: "yellow" }),
    );

    if (this.state === "loading") {
      lines.push("", style(this.t("model.loading"), { dim: true }));
      return lines;
    }

    if (this.state === "choose") {
      lines.push("", style(this.t("auth.chooseType"), { bold: true }));
      const options = this.choiceOptions();
      for (let index = 0; index < options.length; index++) {
        const option = options[index];
        const isSelected = index === this.selectedIndex;
        let row = barIndicator(isSelected);
        row += style(option.label, isSelected ? { bold: true, color: "white" } : { color: "gray" });
        if (option.hint) row += style(` — ${option.hint}`, { dim: true });
        lines.push(clampLine(row, width));
      }
    }

    if (this.state === "prompt") {
      lines.push("", style(this.promptMessage, { bold: true }));
      if (this.isSelectPrompt) {
        const options = this.promptSelectOptions;
        for (let index = 0; index < options.length; index++) {
          const option = options[index];
          const isSelected = index === this.selectedIndex;
          let row = barIndicator(isSelected);
          row += style(option.label, isSelected ? { bold: true, color: "white" } : { color: "gray" });
          if (option.description) row += style(` — ${option.description}`, { dim: true });
          lines.push(clampLine(row, width));
        }
      } else {
        // secret → 显示 API Key 标签；其它（text/manual_code）用通用行首标记
        const label = this.promptType === "secret"
          ? style(`${this.t("auth.apiKeyLabel")}: `, { color: "cyan" })
          : style("> ", { color: "cyan" });
        const labelWidth = visibleWidth(label);
        const inputLine = this.promptField.render(Math.max(1, width - labelWidth))[0] ?? "";
        lines.push(clampLine(label + inputLine, width));
      }
    }

    if (this.state === "running" || this.infoLines.length > 0) {
      lines.push("");
      if (this.state === "running" && this.infoLines.length === 0) {
        lines.push(style(this.t("auth.loggingIn"), { color: "yellow" }));
      }
      for (const line of this.infoLines) {
        lines.push(clampLine(style(line, { dim: true }), width));
      }
    }

    if (this.error) {
      lines.push("", style(this.t("auth.failed", { error: this.error }), { color: "red" }));
    }

    lines.push("", style(this.footerText(), { dim: true }));
    return lines;
  }

  // ==================== 内部实现 ====================

  private authTypeLabel(type: AuthType): string {
    return type === "oauth" ? this.t("provider.authOauth") : this.t("provider.authApiKey");
  }

  private get isSelectPrompt(): boolean {
    return this.promptSelectOptions.length > 0;
  }

  private promptSelectOptions: readonly { id: string; label: string; description?: string }[] = [];

  private footerText(): string {
    switch (this.state) {
      case "configured":
        return this.t("auth.footerConfigured");
      case "prompt":
        return this.isSelectPrompt ? this.t("auth.footerChoose") : this.t("auth.footerApiKey");
      case "choose":
        return this.t("auth.footerChoose");
      default:
        return this.t("common.escBack");
    }
  }

  private choiceOptions(): { label: string; hint?: string; type: AuthType }[] {
    const options: { label: string; hint?: string; type: AuthType }[] = [];
    if (this.hasOAuth) {
      options.push({
        label: this.oauthLabel || this.t("auth.useOAuth"),
        hint: this.t("auth.oauthHint"),
        type: "oauth",
      });
    }
    if (this.hasApiKey) {
      options.push({ label: this.t("auth.useApiKey"), type: "api_key" });
    }
    return options;
  }

  private handleChoiceKey(data: string): boolean {
    const options = this.choiceOptions();
    if (options.length === 0) return true;

    if (matchesKey(data, "up") || data === "k") {
      this.selectedIndex = Math.max(0, this.selectedIndex - 1);
      this.refresh();
      return true;
    }
    if (matchesKey(data, "down") || data === "j") {
      this.selectedIndex = Math.min(options.length - 1, this.selectedIndex + 1);
      this.refresh();
      return true;
    }
    if (matchesKey(data, "return")) {
      const selected = options[this.selectedIndex];
      if (selected) void this.startLogin(selected.type);
      return true;
    }
    return true;
  }

  private handleBack(): void {
    if (this.state === "prompt" || this.state === "running") {
      this.abortLogin();
      this.state = this.configured ? "configured" : "choose";
      this.infoLines = [];
      this.error = null;
      this.refresh();
      return;
    }
    this.abortLogin();
    this.app.releaseEsc();
    this.app.navigate(-1);
  }

  private abortLogin(): void {
    if (this.loginController) {
      this.loginController.abort();
      this.loginController = null;
    }
    if (this.promptReject) {
      this.promptReject(new Error("cancelled"));
      this.promptResolve = null;
      this.promptReject = null;
    }
  }

  private async load(): Promise<void> {
    if (!this.providerId) {
      this.app.navigate("/config/provider");
      return;
    }

    try {
      const provider = getZreadProvider(this.providerId);
      if (!provider) {
        this.state = "error";
        this.error = `Provider "${this.providerId}" not found`;
        this.refresh();
        return;
      }

      this.providerName = provider.name;
      this.hasOAuth = Boolean(provider.auth.oauth?.login);
      this.hasApiKey = Boolean(provider.auth.apiKey?.login);

      const check = await this.checkAuth();
      this.applyAuthStatus(check);

      if (this.configured) {
        this.state = "configured";
      } else {
        this.beginChoose();
      }
    } catch (err) {
      this.state = "error";
      this.error = err instanceof Error ? err.message : String(err);
    }
    this.refresh();
  }

  private async checkAuth(): Promise<{ type?: AuthType; source?: string } | undefined> {
    // 通过 catalog 的 checkAuth（不触发 OAuth 刷新）
    const result = await getZreadCatalog().models.checkAuth(this.providerId);
    return result ?? undefined;
  }

  private applyAuthStatus(status: { type?: AuthType; source?: string } | undefined): void {
    this.configured = status !== undefined;
    this.configuredType = status?.type ?? null;
    this.configuredSource = status?.source ?? "";
  }

  /** 进入登录方式选择（只有一种方式时直接开始） */
  private beginChoose(): void {
    this.infoLines = [];
    this.error = null;
    this.selectedIndex = 0;

    const methods: AuthType[] = [];
    if (this.hasOAuth) methods.push("oauth");
    if (this.hasApiKey) methods.push("api_key");

    if (methods.length === 0) {
      // 只能靠环境变量 / 外部配置（如 AWS、Vertex ADC）
      this.state = "configured";
      this.infoLines = [`${this.providerId} 使用环境变量/外部凭据`];
      this.refresh();
      return;
    }
    if (methods.length === 1) {
      this.state = "choose";
      void this.startLogin(methods[0]);
      return;
    }
    this.state = "choose";
    this.refresh();
  }

  private async startLogin(type: AuthType): Promise<void> {
    this.state = "running";
    this.infoLines = [];
    this.error = null;
    this.refresh();

    const controller = new AbortController();
    this.loginController = controller;

    try {
      await loginZreadProvider(this.providerId, type, {
        signal: controller.signal,
        prompt: (prompt) => this.handlePrompt(prompt as AuthPromptLike),
        notify: (event) => this.handleNotify(event as AuthEventLike),
      });
      this.loginController = null;
      this.applyAuthStatus({ type, source: "stored credential" });
      this.app.config.setProviderConfig(this.providerId, { auth_type: type });
      await this.useModel();
    } catch (err) {
      this.loginController = null;
      if (controller.signal.aborted) {
        // 用户主动取消：回到选择/配置状态
        this.state = this.configured ? "configured" : "choose";
        this.refresh();
        return;
      }
      this.state = "error";
      this.error = err instanceof Error ? err.message : String(err);
      this.refresh();
    }
  }

  // ---- pi-ai AuthInteraction 适配 ----

  private handlePrompt(prompt: AuthPromptLike): Promise<string> {
    return new Promise<string>((resolve, reject) => {
      this.promptMessage = prompt.message;
      this.promptType = prompt.type;
      this.promptSelectOptions =
        prompt.type === "select" && Array.isArray(prompt.options) ? prompt.options : [];
      this.selectedIndex = 0;
      this.promptField.setValue("");
      this.promptField.setPlaceholder(prompt.placeholder ?? "");

      if (prompt.signal) {
        if (prompt.signal.aborted) {
          reject(new Error("cancelled"));
          return;
        }
        prompt.signal.addEventListener(
          "abort",
          () => {
            if (this.promptReject === reject) {
              this.promptResolve = null;
              this.promptReject = null;
            }
            reject(new Error("cancelled"));
          },
          { once: true },
        );
      }

      this.promptResolve = (value) => {
        this.promptResolve = null;
        this.promptReject = null;
        resolve(value);
      };
      this.promptReject = (error) => {
        this.promptReject = null;
        this.promptResolve = null;
        reject(error);
      };

      this.state = "prompt";
      this.refresh();
    });
  }

  private submitPrompt(value: string): void {
    const resolver = this.promptResolve;
    if (!resolver) return;
    const trimmed = value.trim();
    if (!trimmed) {
      this.error = this.t("apikey.required");
      this.refresh();
      return;
    }
    this.error = null;
    this.state = "running";
    this.infoLines = [];
    resolver(trimmed);
    this.refresh();
  }

  private handleNotify(event: AuthEventLike): void {
    switch (event.type) {
      case "auth_url": {
        if (event.url) {
          this.infoLines.push(this.t("auth.openUrl", { url: event.url }));
          void import("open")
            .then((mod) => mod.default(event.url as string))
            .catch(() => {
              // 无浏览器环境时保留 URL 供手动复制
            });
        }
        if (event.instructions) this.infoLines.push(event.instructions);
        break;
      }
      case "device_code": {
        this.infoLines.push(
          this.t("auth.deviceCode", {
            code: event.userCode ?? "",
            uri: event.verificationUri ?? "",
          }),
        );
        break;
      }
      case "progress":
      case "info": {
        if (event.message) this.infoLines.push(event.message);
        break;
      }
    }
    this.refresh();
  }

  /** 选中的模型 + 凭据就绪：设为当前模型并返回 */
  private async useModel(): Promise<void> {
    // 旧版扁平字段先迁移（在切换 provider 之前，避免张冠李戴）
    await migrateLegacyCredentials(this.app.config);

    // URL 里带来的模型如果不在 provider 目录里（旧配置/自定义 id），自动登记为自定义模型
    if (!getZreadModel(this.providerId, this.modelId)) {
      this.app.config.upsertCustomModel(this.providerId, { id: this.modelId, name: this.modelId });
    }
    this.app.config.setActiveModel(this.providerId, this.modelId);
    setZreadCatalogConfig(this.app.config.config);
    this.app.releaseEsc();
    this.app.navigate(-1);
  }

  private async logout(): Promise<void> {
    try {
      await logoutZreadProvider(this.providerId);
      this.app.config.setProviderConfig(this.providerId, { auth_type: null });
      this.applyAuthStatus(undefined);
      this.state = "choose";
      this.infoLines = [this.t("auth.loggedOut")];
      this.refresh();
    } catch (err) {
      this.error = err instanceof Error ? err.message : String(err);
      this.refresh();
    }
  }
}
