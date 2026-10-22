import { NextResponse } from "next/server";
import { readErpStatus } from "@/lib/erpnext";
import { readDashboardState } from "@/lib/storage";
import type { DashboardState } from "@/lib/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const [state, erpnext] = await Promise.all([readDashboardState(), readErpStatus()]);
    const payload: DashboardState = { ...state, erpnext };
    return NextResponse.json(payload, {
      headers: { "Cache-Control": "no-store" },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Could not load dashboard state";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
