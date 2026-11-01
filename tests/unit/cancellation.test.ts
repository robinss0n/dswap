import { describe, expect, it } from "vitest";
import { allToolsCancelled, isUserCancellation } from "../../src/runtime/cancellation.js";

describe("Droid cancellation results", () => {
  it.each([
    "Error: Tool execution cancelled by user",
    "Tool execution cancelled by user",
    "Error: tool execution cancelled",
    "Error: 工具执行已取消",
    "Error: Tool execution was cancelled",
    "Error: Tool execution was interrupted",
    "Request interrupted by user",
  ])("recognizes %s as a user cancellation", (text) => {
    expect(isUserCancellation(text, true)).toBe(true);
    expect(isUserCancellation([{ type: "text", text }], true)).toBe(true);
  });

  it("requires an error result and the whole text", () => {
    expect(isUserCancellation("Error: tool execution cancelled", false)).toBe(false);
    expect(isUserCancellation("Error: tool execution cancelled because the file was missing", true)).toBe(false);
    expect(isUserCancellation([{ type: "text", text: "tool execution cancelled" }, { type: "image", source: {} } as never], true)).toBe(false);
  });

  it("treats a batch as cancelled only when every pending call has only cancellation receipts", () => {
    const cancel = { content: "Error: tool execution cancelled", is_error: true };
    expect(allToolsCancelled(["a", "b"], [{ tool_use_id: "a", ...cancel }, { tool_use_id: "b", ...cancel }])).toBe(true);
    expect(allToolsCancelled(["a", "b"], [{ tool_use_id: "a", ...cancel }])).toBe(false);
    expect(allToolsCancelled(["a"], [{ tool_use_id: "a", content: "done", is_error: false }])).toBe(false);
    expect(allToolsCancelled([], [])).toBe(false);
  });
});
