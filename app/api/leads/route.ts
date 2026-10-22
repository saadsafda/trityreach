import { NextResponse } from "next/server";
import { leadKeyForClient } from "@/lib/lead-key";
import {
  appendActivityEvent,
  appendManualLead,
  ensureDataDirectory,
  readLeads,
} from "@/lib/storage";
import { validateLead } from "@/lib/lead-input";
import type { Lead } from "@/lib/types";

export const runtime = "nodejs";

function normalizeLead(body: Record<string, unknown>): Lead {
  const result = validateLead(body);
  if ("error" in result) throw new Error(result.error);
  return result.lead;
}

export async function POST(request: Request) {
  try {
    const body = (await request.json()) as Record<string, unknown>;
    const lead = normalizeLead(body);

    const existing = await readLeads();
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
