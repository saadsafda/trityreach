import { NextResponse } from "next/server";
import { isProcessRunning, readStatus } from "@/lib/storage";
import { forgetSearchMemory, readSearchMemory } from "@/lib/store-search-memory";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function parseLocations(value: unknown): string[] {
  const list = Array.isArray(value) ? value : String(value ?? "").split("|");
  return list.map((item) => String(item).trim()).filter(Boolean).slice(0, 20);
}

/** GET /api/store-search?locations=08831|Edison, NJ → what earlier Store
 * Finder runs already covered there. */
export async function GET(request: Request) {
  const locations = parseLocations(new URL(request.url).searchParams.get("locations"));
  try {
    return NextResponse.json(readSearchMemory(locations), { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Could not read the search memory";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

/** DELETE { locations: [...] } → start those locations' searches over. */
export async function DELETE(request: Request) {
  try {
    const body = (await request.json()) as { locations?: unknown };
    const locations = parseLocations(body.locations);
    if (!locations.length) throw new Error("Choose the locations to start over.");
    const status = await readStatus();
    if (["queued", "discovering", "running", "enriching"].includes(status.status) && isProcessRunning(status.pid)) {
      return NextResponse.json({ error: "Wait for the current run to finish first." }, { status: 409 });
    }
    forgetSearchMemory(locations);
    return NextResponse.json(readSearchMemory(locations));
  } catch (error) {
    const message = error instanceof Error ? error.message : "Could not reset the search memory";
    return NextResponse.json({ error: message }, { status: 400 });
  }
}
