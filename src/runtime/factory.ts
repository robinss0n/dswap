import type { BridgeConfig } from "../config.js";
import type { Logger } from "../logging.js";
import { AntigravityRuntime } from "./antigravity/runtime.js";
import { CodexRuntime } from "./codex/runtime.js";
import { CursorSdkRuntime } from "./cursor/sdk-runtime.js";
import { FakeRuntime } from "./fake-runtime.js";
import { MockRuntime } from "./mock-runtime.js";
import { RouterRuntime } from "./router-runtime.js";
import { SdkRuntime } from "./sdk-runtime.js";
import type { BridgeRuntime } from "./types.js";

export function createRuntime(config: BridgeConfig, logger: Logger, canaryPath: string): BridgeRuntime {
  if (config.mode === "mock") return new MockRuntime(canaryPath);
  if (config.mode === "fake") return new FakeRuntime();
  const claude = new SdkRuntime(config, logger);
  const has = (provider: string) => (config.models ?? []).some((model) => model.provider === provider);
  if (!has("cursor") && !has("codex") && !has("google")) return claude;
  return new RouterRuntime(claude, has("cursor") ? new CursorSdkRuntime(config, logger) : undefined, has("codex") ? new CodexRuntime(config, logger) : undefined,
    has("google") ? new AntigravityRuntime(config, logger) : undefined);
}
