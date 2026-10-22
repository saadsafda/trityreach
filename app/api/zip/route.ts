import { NextResponse } from "next/server";
import { ensureDataDirectory } from "@/lib/storage";
import { isZip, resolveZip } from "@/lib/zip";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** GET /api/zip?zip=08817 → { zip, lat, lng, label: "Edison, NJ" } */
export async function GET(request: Request) {
  const zip = new URL(request.url).searchParams.get("zip")?.trim() ?? "";
  if (!isZip(zip)) return NextResponse.json({ error: "Enter a 5-digit US ZIP code." }, { status: 400 });
  try {
    await ensureDataDirectory();
    const area = await resolveZip(zip);
    if (!area) return NextResponse.json({ error: `ZIP code ${zip} wasn't found.` }, { status: 404 });
    return NextResponse.json(area);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Could not look up that ZIP code";
    return NextResponse.json({ error: message }, { status: 502 });
  }
}
