import { NextResponse } from "next/server";
import { isAuthorizedInboundRequest } from "@/lib/inbound-auth";
import { appendConversationEntry, ensureDataDirectory, readConversations } from "@/lib/storage";
import type { ConversationChannel, ConversationDirection, ConversationEntry } from "@/lib/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const CHANNELS: readonly ConversationChannel[] = ["email", "whatsapp", "call", "crm"];
const DIRECTIONS: readonly ConversationDirection[] = ["outbound", "inbound"];

function normalizeEntry(body: Record<string, unknown>): ConversationEntry {
  const leadKey = String(body.leadKey ?? "").trim().toLowerCase();
  if (!leadKey) throw new Error("leadKey is required (the lead's email or phone).");

  const channel = String(body.channel ?? "").trim().toLowerCase();
  if (!CHANNELS.includes(channel as ConversationChannel)) {
    throw new Error(`channel must be one of: ${CHANNELS.join(", ")}`);
  }

  const direction = String(body.direction ?? "outbound").trim().toLowerCase();
  if (!DIRECTIONS.includes(direction as ConversationDirection)) {
    throw new Error(`direction must be one of: ${DIRECTIONS.join(", ")}`);
  }

  const content = String(body.content ?? "").trim();
  if (!content) throw new Error("content is required.");
  if (content.length > 8000) throw new Error("content must be 8000 characters or fewer.");

  return {
    id: crypto.randomUUID(),
    leadKey,
    channel: channel as ConversationChannel,
    direction: direction as ConversationDirection,
    subject: body.subject ? String(body.subject).slice(0, 300) : undefined,
    content,
    status: body.status ? String(body.status).slice(0, 100) : undefined,
    createdAt: new Date().toISOString(),
  };
}

export async function GET() {
  try {
    return NextResponse.json(
      { conversations: await readConversations() },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : "Could not load conversations";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

export async function POST(request: Request) {
  if (!isAuthorizedInboundRequest(request)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  try {
    const body = (await request.json()) as Record<string, unknown>;
    const entry = normalizeEntry(body);
    await ensureDataDirectory();
    await appendConversationEntry(entry);
    return NextResponse.json({ entry }, { status: 201 });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Could not log the conversation entry";
    return NextResponse.json({ error: message }, { status: 400 });
  }
}
