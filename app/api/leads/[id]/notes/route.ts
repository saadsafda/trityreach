import { NextResponse } from "next/server";
import { addNote, deleteNote, listNotes } from "@/lib/lead-db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Context = { params: Promise<{ id: string }> };

function positiveInt(value: unknown): number | null {
  const number = Number(value);
  return Number.isInteger(number) && number > 0 ? number : null;
}

/** GET → { notes: [...] }, newest first. */
export async function GET(_request: Request, { params }: Context) {
  const leadId = positiveInt((await params).id);
  if (!leadId) return NextResponse.json({ error: "Unknown lead." }, { status: 400 });
  try {
    return NextResponse.json({ notes: listNotes(leadId) }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Could not load the notes";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

/** POST { body } → { note } */
export async function POST(request: Request, { params }: Context) {
  const leadId = positiveInt((await params).id);
  if (!leadId) return NextResponse.json({ error: "Unknown lead." }, { status: 400 });
  try {
    const payload = (await request.json()) as { body?: unknown };
    return NextResponse.json({ note: addNote(leadId, String(payload.body ?? "")) }, { status: 201 });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Could not save the note";
    return NextResponse.json({ error: message }, { status: 400 });
  }
}

/** DELETE ?noteId=12 */
export async function DELETE(request: Request, { params }: Context) {
  const leadId = positiveInt((await params).id);
  const noteId = positiveInt(new URL(request.url).searchParams.get("noteId"));
  if (!leadId || !noteId) return NextResponse.json({ error: "Unknown note." }, { status: 400 });
  try {
    deleteNote(leadId, noteId);
    return NextResponse.json({ ok: true });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Could not delete the note";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
