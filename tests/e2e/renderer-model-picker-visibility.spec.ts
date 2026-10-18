import { expect, test } from "@playwright/test";
import { build } from "esbuild";
import path from "node:path";

import { normalizeClaudeModelCatalog } from "../../packages/adapters/claude-code/src/model-catalog.js";

const browserExecutable = process.env.CODEXHOST_PLAYWRIGHT_EXECUTABLE_PATH;
if (browserExecutable) test.use({ launchOptions: { executablePath: browserExecutable } });

const { catalog } = normalizeClaudeModelCatalog({
  models: ["default", "fable", "haiku", "sonnet", "opus"].map((value) => ({
    value,
    displayName: value,
  })),
  canSelectModel: true,
  canSelectPermissionMode: true,
});
const { outputFiles } = await build({
  stdin: {
    contents: `
      import { mountRendererModelPicker, renderRendererModelPicker }
        from "./packages/renderer-extension/src/renderer-model-picker.ts";
      globalThis.setupPicker = (selectedLabel) => {
        const catalog = ${JSON.stringify(catalog)};
        const view = {
          status: "ready", catalog,
          selected: catalog.models.find((model) => model.label === selectedLabel).ref,
          selectedThinkingOptionId: "auto",
        };
        const control = mountRendererModelPicker("visibility", () => {}, (id) => {
          globalThis.selectedThinking = id;
          view.selectedThinkingOptionId = id;
          renderRendererModelPicker(control, view, true, "claude-code");
        });
        document.body.append(control.root);
        renderRendererModelPicker(control, view, true, "claude-code");
      };
    `,
    resolveDir: path.resolve(import.meta.dirname, "../.."),
    loader: "ts",
  },
  bundle: true,
  format: "iife",
  platform: "browser",
  write: false,
});
const bundle = outputFiles[0]?.text;
if (!bundle) throw new Error("Model picker visibility bundle was not generated");

for (const selected of ["default", "sonnet", "opus"]) {
  test(`filters menus while preserving the existing ${selected}/Auto selection`, async ({
    page,
  }) => {
    await page.setContent(
      '<!doctype html><body style="display:flex;align-items:flex-end;height:100vh;margin:0"></body>',
    );
    await page.addScriptTag({ content: bundle });
    await page.evaluate((label) => Reflect.get(globalThis, "setupPicker")(label), selected);
    const trigger = page.locator('[data-codexhost-model-control="visibility"] > button');
    await expect(trigger).toHaveAttribute("aria-label", `Model: ${selected}, Auto`);
    await expect(trigger).toBeEnabled();
    await trigger.click();
    if (selected !== "default") {
      const options = page.locator("button[data-thinking-option-id]");
      expect(
        await options.evaluateAll((nodes) =>
          nodes.map((node) => node.getAttribute("data-thinking-option-id")),
        ),
      ).toEqual(["medium", "high", "xhigh", "max", "ultracode"]);
      await page.locator('button[data-thinking-option-id="high"]').click();
      expect(await page.evaluate(() => Reflect.get(globalThis, "selectedThinking"))).toBe("high");
      await expect(trigger).toHaveAttribute("aria-label", `Model: ${selected}, High`);
      await trigger.click();
    }
    await page.locator("button[data-open-model-menu]").click();
    const menu = page.getByRole("menu", { name: "Model", exact: true });
    await expect(menu.locator("button[data-model-id] > span:first-child")).toHaveText([
      "opus",
      "sonnet",
    ]);
    await expect(menu.locator("button[data-favorite-model-id]")).toHaveCount(2);
    await menu.getByRole("searchbox").fill("haiku");
    await expect(menu.locator("button[data-model-id]:visible")).toHaveCount(0);
  });
}
