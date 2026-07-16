import {
  deleteNote,
  getObsidianStatus,
  listNotes,
  readNote,
  resolveWikilink,
  scaffoldVault,
  searchNotes,
  writeNote,
  type WriteMode,
} from "@/lib/obsidian";
import { pushFeed } from "@/lib/feed";

export const runtime = "nodejs";

export async function GET(req: Request) {
  const url = new URL(req.url);
  const action = url.searchParams.get("action") ?? "status";

  if (action === "status") {
    return Response.json(await getObsidianStatus());
  }

  if (action === "list") {
    const prefix = url.searchParams.get("prefix") ?? undefined;
    const notes = await listNotes(undefined, prefix ?? undefined);
    return Response.json({ notes });
  }

  if (action === "read") {
    const pathParam = url.searchParams.get("path") ?? "";
    const result = await readNote(pathParam);
    if (!result.ok) {
      return Response.json({ error: result.error }, { status: 404 });
    }
    return Response.json({ note: result.note });
  }

  if (action === "search") {
    const q = url.searchParams.get("q") ?? "";
    const hits = await searchNotes(q);
    return Response.json({ hits, q });
  }

  if (action === "resolve") {
    const link = url.searchParams.get("link") ?? "";
    const result = await resolveWikilink(link);
    if (!result.ok) {
      return Response.json(
        { error: result.error, candidates: result.candidates },
        { status: 404 },
      );
    }
    return Response.json({ rel: result.rel });
  }

  return Response.json({ error: "unknown action" }, { status: 400 });
}

export async function POST(req: Request) {
  const body = (await req.json()) as {
    action?: string;
    path?: string;
    content?: string;
    mode?: WriteMode;
    confirmToken?: string;
    link?: string;
  };

  const action = body.action ?? "write";

  if (action === "init" || action === "scaffold") {
    const result = await scaffoldVault();
    if (!result.ok) {
      return Response.json({ error: result.error }, { status: 500 });
    }
    pushFeed("EXEC", `Vault scaffold · ${result.vaultRoot}`);
    return Response.json(result);
  }

  if (action === "write") {
    const notePath = body.path?.trim();
    if (!notePath) {
      return Response.json({ error: "path required" }, { status: 400 });
    }
    if (typeof body.content !== "string") {
      return Response.json({ error: "content required" }, { status: 400 });
    }
    const mode: WriteMode = body.mode ?? "create";
    const result = await writeNote({
      relativePath: notePath,
      content: body.content,
      mode,
      confirmToken: body.confirmToken,
    });
    if (!result.ok) {
      const status = result.held ? 428 : 400;
      return Response.json(result, { status });
    }
    pushFeed("EXEC", `Vault ${result.mode} · ${result.rel}`);
    return Response.json(result);
  }

  if (action === "delete") {
    const notePath = body.path?.trim();
    if (!notePath) {
      return Response.json({ error: "path required" }, { status: 400 });
    }
    const result = await deleteNote({
      relativePath: notePath,
      confirmToken: body.confirmToken,
    });
    if (!result.ok) {
      const status = result.held ? 428 : 400;
      return Response.json(result, { status });
    }
    pushFeed("EXEC", `Vault delete · ${result.rel}`);
    return Response.json(result);
  }

  return Response.json({ error: "unknown action" }, { status: 400 });
}
