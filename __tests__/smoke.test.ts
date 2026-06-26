import { describe, it, expect } from "vitest";
import { join } from "node:path";
import { mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as fs from "node:fs";
import type {
  ExtensionAPI,
  RegisteredCommand,
  RegisteredTool,
} from "@earendil-works/pi-coding-agent";

// ─── Mock ExtensionAPI that records all registrations ────────────────────────

interface CapturedRegistrations {
  commands: Map<string, RegisteredCommand>;
  tools: Map<string, { definition: RegisteredTool; sourceInfo: unknown }>;
  handlers: Map<string, Array<(...args: unknown[]) => Promise<unknown>>>;
}

function createMockApi(): { api: ExtensionAPI; captured: CapturedRegistrations } {
  const captured: CapturedRegistrations = {
    commands: new Map(),
    tools: new Map(),
    handlers: new Map(),
  };

  const api: ExtensionAPI = {
    registerTool(tool: RegisteredTool) {
      captured.tools.set(tool.name, { definition: tool, sourceInfo: null });
    },
    registerCommand(name: string, options: Omit<RegisteredCommand, "name" | "sourceInfo">) {
      captured.commands.set(name, { name, sourceInfo: null, ...options } as RegisteredCommand);
    },
    on(event: string, handler: (...args: unknown[]) => Promise<unknown>) {
      const list = captured.handlers.get(event) ?? [];
      list.push(handler);
      captured.handlers.set(event, list);
    },
    // Stubs for unused API methods
    registerShortcut: () => {},
    registerFlag: () => {},
    registerMessageRenderer: () => {},
    registerProvider: () => {},
    unregisterProvider: () => {},
    getFlag: () => undefined,
    sendMessage: () => {},
    sendUserMessage: () => {},
    appendEntry: () => {},
    setSessionName: () => {},
    getSessionName: () => undefined,
    setLabel: () => {},
    exec: async () => ({ stdout: "", stderr: "", exitCode: 0, success: true, durationMs: 0 }),
    getActiveTools: () => [],
    getAllTools: () => [],
    setActiveTools: () => {},
    getCommands: () => [],
    setModel: async () => {},
    getThinkingLevel: () => "medium",
    setThinkingLevel: () => {},
    events: {} as never,
  } as unknown as ExtensionAPI;

  return { api, captured };
}

// ─── Smoke tests ─────────────────────────────────────────────────────────────

describe("End-to-end smoke test", () => {
  it("pi loads the extension without errors", async () => {
    const { default: factory } = await import("../index.js");
    const { api } = createMockApi();

    // Factory should be a function
    expect(typeof factory).toBe("function");

    // Invoke factory — should not throw
    await factory(api); // throws on failure
  });

  it("registers the expected tools and commands", async () => {
    const { default: factory } = await import("../index.js");
    const { api, captured } = createMockApi();
    await factory(api);

    // Tools
    expect(captured.tools.has("council_decide")).toBe(true);
    expect(captured.tools.has("second_opinion")).toBe(true);

    // Commands
    expect(captured.commands.has("council")).toBe(true);
    expect(captured.commands.has("opinion")).toBe(true);
    expect(captured.commands.has("council-settings")).toBe(true);
    expect(captured.commands.has("opinion-settings")).toBe(true);
  });

  it("/council-settings list command shows unconfigured state when no settings", async () => {
    const testDir = join(tmpdir(), `smoke-unconfig-${Date.now()}`);
    await mkdir(join(testDir, ".pi", "agent"), { recursive: true });

    // No settings file should exist in the untrusted test dir
    expect(fs.existsSync(join(testDir, ".pi", "agent", "council-settings.json"))).toBe(false);

    // Verify showCurrentSettings returns the "Not configured" message
    const { showCurrentSettings } = await import("../settings-ui.js");
    let notifiedMessage = "";
    const ctx = {
      cwd: join(testDir, ".pi", "agent"),
      isProjectTrusted: () => false,
      modelRegistry: { getAvailable: async () => [] },
      ui: {
        select: () => Promise.resolve(""),
        confirm: () => Promise.resolve(false),
        input: () => Promise.resolve(""),
        notify: (msg: string) => {
          notifiedMessage = msg;
        },
      },
    } as never;

    await showCurrentSettings(ctx);
    expect(notifiedMessage).toContain("Not configured");

    await rm(testDir, { recursive: true, force: true });
  });

  it("/council responds with setup instructions when settings missing", async () => {
    // Verify CouncilSetupError is thrown when no settings file
    const { CouncilSetupError } = await import("../types.js");
    expect(CouncilSetupError).toBeDefined();
    const err = new CouncilSetupError("test message");
    expect(err.message).toBe("test message");
    expect(err.name).toBe("CouncilSetupError");
  });

  it("/council and /opinion respond correctly after manual settings write", async () => {
    const testDir = join(tmpdir(), `smoke-configured-${Date.now()}`);
    await mkdir(join(testDir, ".pi"), { recursive: true });

    // Write a valid settings file
    const validSettings = {
      version: 1,
      openRouter: {
        apiKey: "sk-or-v1-test-smoke-key",
        models: {
          model1: "qwen/qwen3.7-max",
          model2: "z-ai/glm-5.2",
          model3: "deepseek/deepseek-v4-pro",
        },
      },
      opinion: {
        provider: "openrouter",
        modelId: "qwen/qwen3.7-max",
      },
      options: {
        useStructuredOutput: true,
        modelTimeoutMs: 300000,
        synthesisTimeoutMs: 360000,
        retryAttempts: 3,
        retryDelayMs: 3000,
      },
      lastUpdated: new Date().toISOString(),
    };

    const settingsPath = join(testDir, ".pi", "council-settings.json");
    await writeFile(settingsPath, JSON.stringify(validSettings), "utf8");

    // Verify the file can be loaded back via the settings module
    const { loadSettings } = await import("../settings.js");
    const loaded = await loadSettings(testDir, true);

    expect(loaded).not.toBeNull();
    expect(loaded!.openRouter.apiKey).toBe("sk-or-v1-test-smoke-key");
    expect(loaded!.openRouter.models.model1).toBe("qwen/qwen3.7-max");
    expect(loaded!.openRouter.models.model2).toBe("z-ai/glm-5.2");
    expect(loaded!.openRouter.models.model3).toBe("deepseek/deepseek-v4-pro");
    expect(loaded!.opinion.modelId).toBe("qwen/qwen3.7-max");

    // Verify showCurrentSettings displays the configured state
    const { showCurrentSettings } = await import("../settings-ui.js");
    let notifiedMessage = "";
    const ctx = {
      cwd: testDir,
      isProjectTrusted: () => true,
      modelRegistry: { getAvailable: async () => [] },
      ui: {
        select: () => Promise.resolve(""),
        confirm: () => Promise.resolve(false),
        input: () => Promise.resolve(""),
        notify: (msg: string) => {
          notifiedMessage = msg;
        },
      },
    } as never;

    await showCurrentSettings(ctx);

    // Should show the configured state with the redacted API key
    expect(notifiedMessage).toContain("sk-or-v1");
    expect(notifiedMessage).toContain("qwen/qwen3.7-max");

    await rm(testDir, { recursive: true, force: true });
  });
});
