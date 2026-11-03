import { NextResponse } from "next/server";
import { leadKeyForClient } from "@/lib/lead-key";
import {
  appendActivityEvent,
  appendManualLead,
  ensureDataDirectory,
  readConversations,
  readLeadPage,
  readSavedLeads,
} from "@/lib/storage";
import { validateLead } from "@/lib/lead-input";
import type { Lead } from "@/lib/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function normalizeLead(body: Record<string, unknown>): Lead {
  const result = validateLead(body);
  if ("error" in result) throw new Error(result.error);
  return result.lead;
}

const PAGE_SIZES = [10, 25, 50, 100];
const DEFAULT_PAGE_SIZE = 25;

/** GET ?page=1&pageSize=25&search=&storeType=&channel=all|whatsapp|email|call|none
 * → one page of the CRM's database, newest first (see LeadPage). */
export async function GET(request: Request) {
  try {
    const params = new URL(request.url).searchParams;
    const page = Number(params.get("page"));
    const pageSize = Number(params.get("pageSize"));
    const channel = params.get("channel") ?? "all";

    // Who was contacted lives in the conversation log, not in the database.
    let onlyKeys: string[] | undefined;
    let exceptKeys: string[] | undefined;
    if (channel !== "all") {
      const entries = await readConversations();
      if (channel === "none") exceptKeys = [...new Set(entries.map((entry) => entry.leadKey))];
      else onlyKeys = [...new Set(entries.filter((entry) => entry.channel === channel).map((entry) => entry.leadKey))];
    }

    const result = await readLeadPage({
      page: Number.isInteger(page) && page > 0 ? page : 1,
      pageSize: PAGE_SIZES.includes(pageSize) ? pageSize : DEFAULT_PAGE_SIZE,
      search: (params.get("search") ?? "").slice(0, 200),
      storeType: params.get("storeType") ?? "",
      onlyKeys,
      exceptKeys,
    });
    return NextResponse.json(result, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Could not load the leads";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

export async function POST(request: Request) {
  try {
    const body = (await request.json()) as Record<string, unknown>;
    const lead = normalizeLead(body);

    const existing = await readSavedLeads();
    const key = leadKeyForClient(lead);
    if (existing.some((other) => leadKeyForClient(other) === key)) {
      return NextResponse.json(
        { error: "A lead with this email/phone already exists." },
        { status: 409 },
      );
    }

    await ensureDataDirectory();
    await appendManualLead(lead);
    await appendActivityEvent({
      id: crypto.randomUUID(),
      type: "lead_found",
      message: `Added lead manually: ${lead.business_name}`,
      detail: "Entered from the dashboard",
      createdAt: new Date().toISOString(),
    });

    return NextResponse.json({ lead }, { status: 201 });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Could not add the lead";
    return NextResponse.json({ error: message }, { status: 400 });
  }
}
