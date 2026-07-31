/**
 * MCP command parsing — how HER chat brain (and the in-call console) turns
 * operator language into bridge calls. PURE and total, tested directly.
 *
 * Grammar (deliberately small and exact — free-form intent stays with the
 * LLM; these are the operator fast-paths):
 *   "mcp tools"                        → list every server + tool
 *   "mcp <server> <tool> [{json}]"     → exact call
 *   "browse <url>"                     → playwright navigate + snapshot
 *     (the walk-through-together primitive: she opens what Classic names)
 */
export type McpCommand =
  | { kind: "list" }
  | { kind: "call"; server: string; tool: string; args: Record<string, unknown> }
  | { kind: "browse"; url: string }
  | null;

export function parseMcpCommand(text: string): McpCommand {
  if (typeof text !== "string") return null;
  const t = text.trim();

  if (/^mcp\s+tools\b/i.test(t)) return { kind: "list" };

  const browse = /^(?:browse|open (?:the )?(?:page|site|url))\s+(\S+)/i.exec(t);
  if (browse) {
    let url = browse[1].replace(/[.,;)\]]+$/, "");
    if (!/^https?:\/\//i.test(url)) url = `https://${url}`;
    try {
      new URL(url);
      return { kind: "browse", url };
    } catch {
      return null;
    }
  }

  const call = /^mcp\s+([a-z0-9_-]+)\s+([a-zA-Z0-9_.-]+)\s*(\{[\s\S]*\})?\s*$/i.exec(t);
  if (call) {
    let args: Record<string, unknown> = {};
    if (call[3]) {
      try {
        const parsed = JSON.parse(call[3]) as unknown;
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
          args = parsed as Record<string, unknown>;
        } else {
          return null;
        }
      } catch {
        return null;
      }
    }
    return { kind: "call", server: call[1].toLowerCase(), tool: call[2], args };
  }

  return null;
}
