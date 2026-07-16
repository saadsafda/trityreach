import { NextResponse } from "next/server";
import { readDashboardState } from "@/lib/storage";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  try {
    return NextResponse.json(await readDashboardState(), {
      headers: { "Cache-Control": "no-store" },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Could not load dashboard state";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
