import { NextResponse } from "next/server";
import { addStoreType, readStoreCatalog, removeStoreType, restoreStoreType } from "@/lib/store-catalog";
import { ensureDataDirectory } from "@/lib/storage";
import { DEFAULT_STORE_TYPES } from "@/lib/store-types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  return NextResponse.json(
    { types: await readStoreCatalog(), defaults: DEFAULT_STORE_TYPES },
    { headers: { "Cache-Control": "no-store" } },
  );
}

/** { action: "add", label, queries[] } | { action: "remove" | "restore", key } */
export async function POST(request: Request) {
  try {
    const body = (await request.json()) as { action?: unknown; label?: unknown; queries?: unknown; key?: unknown };
    await ensureDataDirectory();
    if (body.action === "add") {
      const queries = Array.isArray(body.queries) ? body.queries.map(String) : [];
      await addStoreType(String(body.label ?? ""), queries);
    } else if (body.action === "remove" || body.action === "restore") {
      const key = String(body.key ?? "");
      if (body.action === "remove") await removeStoreType(key);
      else await restoreStoreType(key);
    } else {
      throw new Error("Unknown action.");
    }
    return NextResponse.json({ types: await readStoreCatalog(), defaults: DEFAULT_STORE_TYPES });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Could not update store types";
    return NextResponse.json({ error: message }, { status: 400 });
  }
}
