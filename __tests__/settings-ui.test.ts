import { describe, it, expect, vi, beforeEach } from "vitest";
import { showCurrentSettings } from "../settings-ui.js";
import { createDefaultSettings } from "../settings.js";
import { writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

const getTestDir = () => join(tmpdir(), `pi-mc-ui-test-${Date.now()}-${Math.random()}`);

function createMockCtx(testDir: string) {
  return {
    cwd: testDir,
    isProjectTrusted: () => false,
    modelRegistry: { getAvailable: vi.fn().mockResolvedValue([]) },
    ui: {
      select: vi.fn(),
      confirm: vi.fn(),
      input: vi.fn(),
      notify: vi.fn(),
    },
  } satisfies object;
}

describe("showCurrentSettings", () => {
  let testDir: string;

  beforeEach(async () => {
    testDir = getTestDir();
    // Untrusted settings go to cwd/.pi/agent/
    await mkdir(join(testDir, ".pi", "agent"), { recursive: true });
  });

  it("calls notify with unconfigured message when no settings", async () => {
    const ctx = createMockCtx(testDir);
    await showCurrentSettings(ctx);

    expect(ctx.ui.notify).toHaveBeenCalledOnce();
    const [msg, type] = ctx.ui.notify.mock.calls[0];
    expect(msg).toContain("Not configured");
    expect(type).toBe("info");
  });

  it("calls notify with settings summary when configured", async () => {
    const settings = createDefaultSettings();
    settings.openRouter.apiKey = "sk-or-v1-testkey123456";
    // Write to the correct untrusted path: cwd/.pi/agent/council-settings.json
    await writeFile(
      join(testDir, ".pi", "agent", "council-settings.json"),
      JSON.stringify(settings),
      "utf8",
    );

    const ctx = createMockCtx(testDir);
    await showCurrentSettings(ctx);

    expect(ctx.ui.notify).toHaveBeenCalledOnce();
    const [msg, type] = ctx.ui.notify.mock.calls[0];
    expect(type).toBe("info");
    expect(msg).toContain("sk-or-v1-te"); // redacted but present
  });
});
