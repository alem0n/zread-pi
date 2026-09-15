/**
 * Config Custom Provider Page - 新建/编辑自定义 Provider（pi-tui 版）
 *
 * 路由：
 *   /config/provider/custom              新建（步骤：名称 → Base URL → 协议）
 *   /config/provider/:providerId/edit    编辑已有自定义 Provider（id 固定，只改名称/端点/协议）
 *
 * 与内置 Provider 一样，自定义 Provider 拥有自己的显示名称，并可以在详情页里
 * 添加**多个**模型（API Key 录入与模型列表都在详情页，本页只负责 Provider 身份信息）。
 *
 * 保存时写回 config.llm.providers[id]（name / base_url / api）并重建 catalog；
 * 新建后直接进入该 Provider 的详情页（替换当前页，ESC 回到 Provider 列表）。
 */

import { matchesKey } from "@earendil-works/pi-tui";
import {
  CUSTOM_PROVIDER_APIS,
  getZreadCatalog,
  setZreadCatalogConfig,
} from "@zread-pi/agent-runtime";
import { TextField } from "../../tui/components/text-field";
import { style } from "../../tui/ansi";
import { Screen } from "../../tui/screen";
import { clampLine } from "../../tui/text-layout";
import { uniqueProviderId } from "../../utils/provider-id";

type Step = "name" | "baseUrl" | "api";

const STEP_ORDER: Step[] = ["name", "baseUrl", "api"];

export default class ConfigCustomProviderPage extends Screen {
  /** 编辑模式的目标 provider id；新建模式为空 */
  private providerId: string | undefined;
  private step: Step = "name";

  private name = "";
  private baseUrl = "";
  private apiIndex = 0;
  private errors: Record<Step, string> = { name: "", baseUrl: "", api: "" };

  private nameField = new TextField();
  private baseUrlField = new TextField();

  protected override init(): void {
    const params = this.app.location?.params;
    // /config/provider/:providerId/edit → 编辑模式；/config/provider/custom（无参数）→ 新建
    const paramId = params?.providerId;
    this.providerId = paramId && paramId !== "custom" ? paramId : undefined;

    if (this.providerId) {
      // 编辑模式只允许自定义 Provider：内置 Provider 的名称/端点不应被改写
      if (getZreadCatalog().builtinIds.has(this.providerId)) {
        this.app.navigate(`/config/provider/${encodeURIComponent(this.providerId)}`, {
          replace: true,
        });
        return;
      }
      const existing = this.app.config.getProviderConfig(this.providerId);
      this.name = existing.name ?? "";
      this.baseUrl = existing.base_url ?? "";
      const api = existing.api ?? CUSTOM_PROVIDER_APIS[0];
      this.apiIndex = Math.max(
        0,
        CUSTOM_PROVIDER_APIS.indexOf(api as (typeof CUSTOM_PROVIDER_APIS)[number]),
      );
    }

    this.nameField.onChange = (value) => {
      this.name = value;
    };
    this.baseUrlField.onChange = (value) => {
      this.baseUrl = value;
    };
    this.nameField.onSubmit = () => this.handleNext();
    this.baseUrlField.onSubmit = () => this.handleNext();

    this.nameField.setPlaceholder(this.t("customProvider.namePlaceholder"));
    this.baseUrlField.setPlaceholder(this.t("customProvider.baseUrlPlaceholder"));

    // 预填充的值要同步到输入框
    this.nameField.setValue(this.name);
    this.baseUrlField.setValue(this.baseUrl);

    // 进入页面时声明 ESC 处理权（需要多步骤回退）
    this.app.claimEsc();
    this.updateFocus();
  }

  override handleKey(data: string): boolean {
    if (matchesKey(data, "escape")) {
      this.handleBack();
      return true;
    }

    if (this.step === "api") {
      if (data === "t") {
        this.apiIndex = (this.apiIndex + 1) % CUSTOM_PROVIDER_APIS.length;
        this.errors = { ...this.errors, api: "" };
        this.refresh();
        return true;
      }
      if (matchesKey(data, "return")) {
        this.handleNext();
        return true;
      }
      return false;
    }

    const field = this.step === "name" ? this.nameField : this.baseUrlField;
    if (matchesKey(data, "return")) {
      this.handleNext();
      return true;
    }
    field.handleKey(data);
    return false;
  }

  override onDestroy(): void {
    this.app.releaseEsc();
  }

  render(width: number): string[] {
    const stepNumber = STEP_ORDER.indexOf(this.step) + 1;
    const isEdit = Boolean(this.providerId);

    const lines: string[] = [];
    lines.push(
      "",
      style(
        isEdit
          ? this.t("customProvider.editTitle")
          : this.t("customProvider.createTitle"),
        { bold: true, color: "cyan" },
      ),
    );
    if (isEdit && this.providerId) {
      lines.push(clampLine(style(`${this.t("customProvider.editingId")}: ${this.providerId}`, { dim: true }), width));
    }
    lines.push(
      style(this.t("customProvider.step", { current: stepNumber, total: STEP_ORDER.length }), {
        dim: true,
      }),
    );

    // 步骤: Provider 名称
    lines.push("", this.renderStepHeader("name", this.t("customProvider.name"), this.name, width));
    if (this.step === "name") {
      lines.push(this.renderStepInput(this.nameField, width));
      if (this.errors.name) lines.push(this.renderStepError(this.errors.name, width));
    }

    // 步骤: Base URL
    lines.push(
      "",
      this.renderStepHeader("baseUrl", this.t("customProvider.baseUrl"), this.baseUrl, width),
    );
    if (this.step === "baseUrl") {
      lines.push(this.renderStepInput(this.baseUrlField, width));
      if (this.errors.baseUrl) lines.push(this.renderStepError(this.errors.baseUrl, width));
    }

    // 步骤: API 协议（t 切换）
    lines.push(
      "",
      this.renderStepHeader("api", this.t("customProvider.api"), CUSTOM_PROVIDER_APIS[this.apiIndex], width),
    );
    if (this.step === "api") {
      lines.push(
        clampLine(
          "  " + style(this.t("customProvider.apiHint", { api: CUSTOM_PROVIDER_APIS[this.apiIndex] }), { dim: true }),
          width,
        ),
      );
      if (this.errors.api) lines.push(this.renderStepError(this.errors.api, width));
    }

    lines.push("", style(this.t("customProvider.footer"), { dim: true }));

    return lines;
  }

  // ==================== 内部实现 ====================

  private updateFocus(): void {
    this.nameField.setFocused(this.step === "name");
    this.baseUrlField.setFocused(this.step === "baseUrl");
  }

  private setStep(step: Step): void {
    this.step = step;
    this.updateFocus();
    this.refresh();
  }

  private renderStepHeader(step: Step, label: string, value: string, width: number): string {
    const isCurrent = this.step === step;
    const indicator = style(isCurrent ? "> " : "  ", { color: isCurrent ? "cyan" : "gray" });
    const title = style(label, {
      bold: isCurrent,
      color: isCurrent ? "white" : "gray",
    });
    const suffix =
      !isCurrent && value ? style(`: ${value}`, { dim: true, color: "green" }) : "";
    return clampLine(indicator + title + suffix, width);
  }

  private renderStepInput(field: TextField, width: number): string {
    const available = Math.max(1, width - 2);
    const line = field.render(available)[0] ?? "";
    return clampLine("  " + line, width);
  }

  private renderStepError(message: string, width: number): string {
    return clampLine("  " + style(message, { color: "red" }), width);
  }

  /** URL 格式验证 */
  private validateUrl(url: string): boolean {
    try {
      const parsed = new URL(url);
      return parsed.protocol === "http:" || parsed.protocol === "https:";
    } catch {
      return false;
    }
  }

  /** 前一步（ESC 由此处理，App 不处理） */
  private handleBack(): void {
    this.errors = { name: "", baseUrl: "", api: "" };
    switch (this.step) {
      case "name":
        this.app.releaseEsc();
        this.app.navigate(-1);
        break;
      case "baseUrl":
        this.setStep("name");
        break;
      case "api":
        this.setStep("baseUrl");
        break;
    }
  }

  /** 下一步 / 提交 */
  private handleNext(): void {
    this.errors = { name: "", baseUrl: "", api: "" };
    switch (this.step) {
      case "name": {
        if (!this.name.trim()) {
          this.errors.name = this.t("customProvider.nameRequired");
          this.refresh();
          return;
        }
        this.setStep("baseUrl");
        return;
      }
      case "baseUrl": {
        if (!this.baseUrl.trim()) {
          this.errors.baseUrl = this.t("customProvider.urlRequired");
          this.refresh();
          return;
        }
        if (!this.validateUrl(this.baseUrl)) {
          this.errors.baseUrl = this.t("customProvider.invalidUrl");
          this.refresh();
          return;
        }
        this.setStep("api");
        return;
      }
      case "api":
        this.submit();
        return;
    }
  }

  /** 保存：新建模式生成唯一 id 后进入详情页；编辑模式原地更新后返回详情页 */
  private submit(): void {
    const name = this.name.trim();
    const baseUrl = this.baseUrl.trim();
    const api = CUSTOM_PROVIDER_APIS[this.apiIndex];

    if (this.providerId) {
      this.app.config.setProviderConfig(this.providerId, {
        name,
        base_url: baseUrl || null,
        api,
      });
      setZreadCatalogConfig(this.app.config.config);
      this.app.releaseEsc();
      this.app.navigate(-1);
      return;
    }

    // 新建：id 不能撞上内置 Provider 或已配置的自定义 Provider
    const taken = new Set<string>([
      ...Object.keys(this.app.config.config.llm.providers ?? {}),
      ...getZreadCatalog().builtinIds,
    ]);
    const id = uniqueProviderId(name, taken);

    this.app.config.setProviderConfig(id, {
      name,
      base_url: baseUrl || null,
      api,
    });
    // 让 catalog 立即看到新 Provider（详情页/列表页未保存的修改也能预览）
    setZreadCatalogConfig(this.app.config.config);

    this.app.releaseEsc();
    // 替换当前创建页：ESC 从详情页回到 Provider 列表，而不是回到表单
    this.app.navigate(`/config/provider/${encodeURIComponent(id)}`, { replace: true });
  }
}
