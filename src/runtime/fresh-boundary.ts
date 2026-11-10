import { BridgeError, type MessagesRequest } from "../types.js";

export interface FreshBoundary { v: 1; boundary_id: string; answered_call_ids: string[] }
export function boundaryError(message: string): never { throw new BridgeError(409, "fresh_boundary_rejected", message); }
export function parseFreshBoundary(value: string | string[] | undefined): FreshBoundary | undefined {
  if (value === undefined) return;
  if (typeof value !== "string" || value.length > 8192) boundaryError("Invalid fresh boundary header");
  let data: any;
  try { data = JSON.parse(value); } catch { boundaryError("Invalid fresh boundary JSON"); }
  if (!data || Object.keys(data).some((key) => !["v", "boundary_id", "answered_call_ids"].includes(key))
    || data.v !== 1 || typeof data.boundary_id !== "string" || !/^[A-Za-z0-9._:-]{1,200}$/.test(data.boundary_id)
    || !Array.isArray(data.answered_call_ids) || !data.answered_call_ids.length || data.answered_call_ids.length > 128
    || data.answered_call_ids.some((id: unknown) => typeof id !== "string" || !id.length || id.length > 256)
    || new Set(data.answered_call_ids).size !== data.answered_call_ids.length) boundaryError("Invalid fresh boundary fields");
  return data;
}
/** Canonical objects, ordered arrays. Receipts never retain caller-owned objects. */
export function boundaryCanonical(value: unknown): string {
  return JSON.stringify(value, (_key, item) => item && typeof item === "object" && !Array.isArray(item)
    ? Object.fromEntries(Object.keys(item).sort().map((key) => [key, item[key]])) : item);
}
/** Deliberately separate from ordinary cold import: preserve every ordered block. */
export function boundaryReference(request: MessagesRequest): string {
  for (const message of request.messages) {
    if (typeof message.content === "string") continue;
    for (const block of message.content) {
      if (!["text", "tool_use", "tool_result"].includes(block.type)) boundaryError("Unsupported reference block");
      if (block.type === "image" && (block.source as any)?.type !== "base64") boundaryError("Unsupported reference image");
      if (block.type === "tool_result" && Array.isArray(block.content) && block.content.some((part: any) => part.type !== "text")) boundaryError("Unsupported result content");
    }
  }
  return "Historical reference only. Tool calls and results below already happened; never execute them again. Continue with the next assistant turn.\n" + JSON.stringify(request.messages);
}
