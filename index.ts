import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { councilInputSchema, secondOpinionInputSchema } from "./schemas.js";
import type { CouncilInput, SecondOpinionInput } from "./types.js";
import { CouncilSetupError, OpinionSetupError } from "./types.js";
import { runCouncil } from "./councilRunner.js";
import { runSecondOpinion } from "./secondOpinionRunner.js";
import { parseCouncilCommandArgs, parseSecondOpinionCommandArgs } from "./commandParser.js";
import {
  showCurrentSettings,
  resetSettings,
  openCouncilSettingsUI,
  openOpinionSettingsUI,
} from "./settings-ui.js";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

async function saveLatestCouncilReport(markdown: string): Promise<void> {
  const dir = join(process.cwd(), ".pi", "council");
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "last-decision.md"), markdown, "utf8");
}

async function saveLatestSecondOpinion(markdown: string): Promise<void> {
  const dir = join(process.cwd(), ".pi", "council");
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "last-opinion.md"), markdown, "utf8");
}

export default function modelCouncilExtension(pi: ExtensionAPI) {
  // ── Tools ──────────────────────────────────────────────────────────────────

  // Register the council_decide tool
  pi.registerTool({
    name: "council_decide",
    label: "Model Council Decision",
    description:
      "Ask three hard-coded OpenRouter models for a second opinion on a fix, technical question, or architecture decision. Returns a structured plan for the main Pi coding model to implement. This tool does not edit files or run commands.",
    parameters: councilInputSchema,
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const input = params as unknown as CouncilInput;

      try {
        const result = await runCouncil({
          input,
          signal: ctx.signal,
          onStatus: (message) => ctx.ui.setStatus("model-council", message),
          cwd: ctx.cwd,
          isProjectTrusted: ctx.isProjectTrusted(),
          modelRegistry: ctx.modelRegistry,
        });

        return {
          content: [{ type: "text", text: result.markdown }],
          details: {
            decision: result.decision,
            rawModelResults: result.rawModelResults,
          },
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        ctx.ui.setStatus("model-council", "model-council: failed");

        // Show helpful setup instructions for setup errors
        if (error instanceof CouncilSetupError) {
          ctx.ui.notify(message, "warning");
        }

        return {
          content: [{ type: "text", text: `Model council failed: ${message}` }],
          details: { error: message },
          isError: true,
        };
      }
    },
  });

  // Register the second_opinion tool
  pi.registerTool({
    name: "second_opinion",
    label: "Second Opinion",
    description:
      "Get a quick second opinion from a configurable model on a fix, technical question, or architecture decision. Faster than the full council but uses one model.",
    parameters: secondOpinionInputSchema,
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const input = params as unknown as SecondOpinionInput;

      try {
        const result = await runSecondOpinion({
          input,
          signal: ctx.signal,
          onStatus: (message) => ctx.ui.setStatus("model-council", message),
          cwd: ctx.cwd,
          isProjectTrusted: ctx.isProjectTrusted(),
          modelRegistry: ctx.modelRegistry,
        });

        return {
          content: [{ type: "text", text: result.markdown }],
          details: {
            opinion: result.opinion,
          },
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);

        ctx.ui.setStatus("model-council", "model-council: failed");

        if (error instanceof OpinionSetupError) {
          ctx.ui.notify(message, "warning");
        }

        return {
          content: [{ type: "text", text: `Second opinion failed: ${message}` }],
          details: { error: message },
          isError: true,
        };
      }
    },
  });

  // ── Commands ───────────────────────────────────────────────────────────────

  // Register the /council command
  pi.registerCommand("council", {
    description: "Ask the model council: /council [ask|fix|architecture] \"problem\"",
    handler: async (args, ctx) => {
      try {
        const input = parseCouncilCommandArgs(args);

        ctx.ui.setStatus("model-council", "Council: starting...");

        const result = await runCouncil({
          input,
          signal: ctx.signal,
          onStatus: (message) => ctx.ui.setStatus("model-council", message),
          cwd: ctx.cwd,
          isProjectTrusted: ctx.isProjectTrusted(),
          modelRegistry: ctx.modelRegistry,
        });

        await saveLatestCouncilReport(result.markdown);

        // Notify user
        ctx.ui.notify("Model council complete. Report saved to .pi/council/last-decision.md", "info");

        ctx.ui.setStatus("model-council", "Council: complete");
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        ctx.ui.setStatus("model-council", "Council: failed");
        if (error instanceof CouncilSetupError) {
          ctx.ui.notify(message, "warning");
        } else {
          ctx.ui.notify(`Model council failed: ${message}`, "error");
        }
      }
    },
  });

  // Register the /opinion command
  pi.registerCommand("opinion", {
    description: 'Get a second opinion: /opinion [fix|ask|architecture|general] "problem"',
    handler: async (args, ctx) => {
      try {
        const input = parseSecondOpinionCommandArgs(args);

        ctx.ui.setStatus("model-council", "Second opinion: starting...");

        const result = await runSecondOpinion({
          input,
          signal: ctx.signal,
          onStatus: (message) => ctx.ui.setStatus("model-council", message),
          cwd: ctx.cwd,
          isProjectTrusted: ctx.isProjectTrusted(),
          modelRegistry: ctx.modelRegistry,
        });

        await saveLatestSecondOpinion(result.markdown);

        // Notify user
        ctx.ui.notify("Second opinion complete. Report saved to .pi/council/last-opinion.md", "info");

        ctx.ui.setStatus("model-council", "Second opinion: complete");
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        ctx.ui.setStatus("model-council", "Second opinion: failed");
        if (error instanceof OpinionSetupError) {
          ctx.ui.notify(message, "warning");
        } else {
          ctx.ui.notify(`Second opinion failed: ${message}`, "error");
        }
      }
    },
  });

  // Register the /council-settings command
  pi.registerCommand("council-settings", {
    description:
      "Configure model council: /council-settings [list|reset] — opens interactive UI by default",
    handler: async (args, ctx) => {
      const normalizedArgs = args?.trim().toLowerCase() ?? "";

      if (normalizedArgs === "list") {
        await showCurrentSettings(ctx);
        return;
      }

      if (normalizedArgs === "reset") {
        const confirmed = await ctx.ui.confirm(
          "Reset Council Settings",
          "This will clear all council and opinion settings. Continue?",
        );
        if (confirmed) {
          await resetSettings(ctx, "all");
        }
        return;
      }

      // Default: open settings UI
      await openCouncilSettingsUI(ctx);
    },
  });

  // Register the /opinion-settings command
  pi.registerCommand("opinion-settings", {
    description:
      "Configure second opinion model: /opinion-settings [list|reset] — opens interactive UI by default",
    handler: async (args, ctx) => {
      const normalizedArgs = args?.trim().toLowerCase() ?? "";

      if (normalizedArgs === "list") {
        // Show opinion model from settings
        const { formatSettingsForDisplay } = await import("./settings.js");
        const { loadSettings } = await import("./settings.js");
        const settings = await loadSettings(ctx.cwd, ctx.isProjectTrusted());
        const lines = formatSettingsForDisplay(settings);
        const output = lines.slice(3, 5).join("\n"); // Opinion line only
        ctx.ui.notify(output, "info");
        return;
      }

      if (normalizedArgs === "reset") {
        const confirmed = await ctx.ui.confirm(
          "Reset Opinion Settings",
          "Reset opinion model to default (qwen/qwen3.7-max)?",
        );
        if (confirmed) {
          const { loadSettings, saveSettings, createDefaultSettings } = await import("./settings.js");
          const existing = await loadSettings(ctx.cwd, ctx.isProjectTrusted());
          const settings = existing ?? createDefaultSettings();
          settings.opinion = { provider: "openrouter", modelId: "qwen/qwen3.7-max" };
          settings.lastUpdated = new Date().toISOString();
          await saveSettings(settings, ctx.cwd, ctx.isProjectTrusted());
          ctx.ui.notify("Opinion model reset to qwen/qwen3.7-max", "info");
        }
        return;
      }

      // Default: open opinion settings UI
      await openOpinionSettingsUI(ctx);
    },
  });
}
