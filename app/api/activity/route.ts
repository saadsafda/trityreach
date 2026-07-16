import { NextResponse } from "next/server";
import { isAuthorizedInboundRequest } from "@/lib/inbound-auth";
import { appendActivityEvent, ensureDataDirectory, readActivity } from "@/lib/storage";
import type { ActivityEvent, ActivityEventType } from "@/lib/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const EVENT_TYPES: readonly ActivityEventType[] = [
  "discovering",
  "scraping",
  "enriching",
  "lead_found",
  "webhook_sent",
  "outreach_sent",
  "completed",
  "failed",
];

function normalizeEvent(body: Record<string, unknown>): ActivityEvent {
  const type = String(body.type ?? "").trim().toLowerCase();
  if (!EVENT_TYPES.includes(type as ActivityEventType)) {
    throw new Error(`type must be one of: ${EVENT_TYPES.join(", ")}`);
  }
  const message = String(body.message ?? "").trim();
  if (!message) throw new Error("message is required.");
  if (message.length > 500) throw new Error("message must be 500 characters or fewer.");

  return {
    id: crypto.randomUUID(),
    type: type as ActivityEventType,
    message,
    detail: body.detail ? String(body.detail).slice(0, 500) : undefined,
    createdAt: new Date().toISOString(),
  };
}

export async function GET() {
  try {
    return NextResponse.json(
      { events: await readActivity() },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : "Could not load activity";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

export async function POST(request: Request) {
  if (!isAuthorizedInboundRequest(request)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  try {
    const body = (await request.json()) as Record<string, unknown>;
    const event = normalizeEvent(body);
    await ensureDataDirectory();
    await appendActivityEvent(event);
    return NextResponse.json({ event }, { status: 201 });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Could not log the activity event";
    return NextResponse.json({ error: message }, { status: 400 });
  }
}
