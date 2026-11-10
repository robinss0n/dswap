import type { ContentBlock, Message, MessagesRequest } from "../types.js";

export const MESSAGE_BOUNDARY = "\n\n---\n\n";

/** Droid-compatible transcript encoding. Never use this as executable history. */
export function serializeTranscript(messages: readonly Message[]): string {
  return messages.map((message) => {
    const content = typeof message.content === "string" ? message.content : message.content
      .filter((block) => block.type !== "thinking" || block.thinking !== "")
      .map(serializeBlock).join("\n");
    return `${message.role.toUpperCase()}: ${content}`;
  }).join(MESSAGE_BOUNDARY);
}

function serializeBlock(block: ContentBlock): string {
  switch (block.type) {
    case "text": return String(block.text ?? "");
    case "tool_use": return `TOOL_CALL: ${block.name} input=${JSON.stringify(block.input ?? null)}`;
    case "tool_result": {
      const model = ("model_content" in block ? block.model_content : undefined) ?? ("modelContent" in block ? block.modelContent : undefined);
      const content = block.content;
      const text = typeof model === "string" ? model : typeof content === "string" ? content
        : Array.isArray(content) ? content.map((child) => child && typeof child === "object" && !Array.isArray(child) && child.type === "text" ? child.text : "[Image]").join("\n") : "";
      return `TOOL_RESULT: ${text}`;
    }
    case "thinking": {
      const thinking = String(block.thinking ?? "");
      return `[Thinking: ${thinking.slice(0, 500)}${thinking.length > 500 ? "..." : ""}]`;
    }
    case "redacted_thinking": return "[Redacted thinking]";
    case "image": return "[Image attached]";
    default: return `[Unknown block type: ${block.type}]`;
  }
}

/** Only normalize transport newlines; whitespace and Unicode remain significant. */
export function transcriptRemainder(transcript: string, prefix: string): string | undefined {
  const normalized = transcript.replace(/\r\n/g, "\n");
  const covered = prefix.replace(/\r\n/g, "\n");
  if (!covered) return undefined;
  if (normalized === covered) return "";
  return normalized.startsWith(covered + MESSAGE_BOUNDARY) ? normalized.slice(covered.length + MESSAGE_BOUNDARY.length) : undefined;
}

/** Strict envelope parsing: embedded fences are ambiguous, so fall back to plain. */
export function rewriteFirstSummary(request: MessagesRequest, prefix: string, summary: string): MessagesRequest | undefined {
  if (request.messages.length !== 1 || request.messages[0]?.role !== "user" || summary.includes("```")) return undefined;
  const content = request.messages[0].content;
  const text = typeof content === "string" ? content
    : content.length === 1 && content[0]?.type === "text" ? content[0].text : undefined;
  if (typeof text !== "string") return undefined;
  const normalized = text.replace(/\r\n/g, "\n");
  const opening = "Please summarize the following conversation:\n```\n";
  if (!normalized.startsWith(opening)) return undefined;
  const end = normalized.indexOf("\n```", opening.length);
  if (end < 0 || normalized.indexOf("```", end + 4) >= 0) return undefined;
  const transcript = normalized.slice(opening.length, end);
  const remainder = transcriptRemainder(transcript, prefix);
  if (remainder === undefined) return undefined;
  return { ...request, messages: [{ role: "user", content: `Previous summary:\n\`\`\`\n${summary}\n\`\`\`\n\nThese messages were sent since the previous summary:\n\`\`\`\n${remainder}\n\`\`\`${normalized.slice(end + 4)}` }] };
}
