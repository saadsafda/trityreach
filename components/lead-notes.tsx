"use client";

import { useEffect, useState } from "react";
import { CloseIcon } from "@/components/icons";
import type { LeadNote } from "@/lib/types";

function formatTimestamp(iso: string): string {
  const date = new Date(iso);
  return Number.isNaN(date.getTime())
    ? iso
    : date.toLocaleString([], { month: "short", day: "numeric", year: "numeric", hour: "2-digit", minute: "2-digit" });
}

/** Add, read, and delete a lead's notes. Remount (key) it for another lead. */
export default function LeadNotes({ leadId, onChanged }: { leadId: number; onChanged?: () => void }) {
  const [notes, setNotes] = useState<LeadNote[] | null>(null);
  const [draft, setDraft] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const response = await fetch(`/api/leads/${leadId}/notes`, { cache: "no-store" });
        const payload = (await response.json()) as { notes?: LeadNote[]; error?: string };
        if (!response.ok) throw new Error(payload.error || "Could not load the notes");
        if (!cancelled) setNotes(payload.notes ?? []);
      } catch (caught) {
        if (!cancelled) {
          setNotes([]);
          setError(caught instanceof Error ? caught.message : "Could not load the notes");
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [leadId]);

  async function addNote() {
    setError("");
    setSaving(true);
    try {
      const response = await fetch(`/api/leads/${leadId}/notes`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ body: draft }),
      });
      const payload = (await response.json()) as { note?: LeadNote; error?: string };
      if (!response.ok || !payload.note) throw new Error(payload.error || "Could not save the note");
      const saved = payload.note;
      setNotes((current) => [saved, ...(current ?? [])]);
      setDraft("");
      onChanged?.();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not save the note");
    } finally {
      setSaving(false);
    }
  }

  async function removeNote(noteId: number) {
    if (!window.confirm("Delete this note?")) return;
    setError("");
    try {
      const response = await fetch(`/api/leads/${leadId}/notes?noteId=${noteId}`, { method: "DELETE" });
      if (!response.ok) {
        const payload = (await response.json()) as { error?: string };
        throw new Error(payload.error || "Could not delete the note");
      }
      setNotes((current) => (current ?? []).filter((note) => note.id !== noteId));
      onChanged?.();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not delete the note");
    }
  }

  return (
    <div className="flex flex-col gap-3">
      <textarea
        value={draft}
        onChange={(event) => setDraft(event.target.value)}
        onKeyDown={(event) => {
          if ((event.metaKey || event.ctrlKey) && event.key === "Enter" && draft.trim() && !saving) void addNote();
        }}
        rows={3}
        maxLength={4000}
        aria-label="New note"
        placeholder="Add a note, e.g. owner asked to call back on Monday"
        className="w-full resize-y rounded-xl border border-[#d8d6e2] bg-white px-3.5 py-2.5 text-[13px] leading-[1.5] text-ink outline-none placeholder:text-[#aaa8b6] focus:border-indigo focus:shadow-[0_0_0_3px_rgba(91,79,233,0.09)]"
      />
      <div className="flex justify-end">
        <button
          type="button"
          onClick={() => void addNote()}
          disabled={saving || !draft.trim()}
          className="inline-flex h-[36px] items-center justify-center rounded-[10px] border border-indigo bg-indigo px-4 text-[12px] font-bold text-white hover:enabled:bg-indigo-dark"
        >
          {saving ? "Saving…" : "Add note"}
        </button>
      </div>

      {error && (
        <p className="m-0 rounded-xl border border-[#ffd5dc] bg-[#fff5f6] px-3 py-2 text-[12px] text-[#9e3043]" role="alert">
          {error}
        </p>
      )}

      {notes === null ? (
        <p className="m-0 text-[12px] text-muted">Loading notes…</p>
      ) : notes.length === 0 ? (
        !error && <p className="m-0 text-[12px] text-muted">No notes yet.</p>
      ) : (
        <ol className="m-0 flex list-none flex-col gap-2.5 p-0">
          {notes.map((note) => (
            <li key={note.id} className="rounded-xl border border-line bg-[#fbfbfd] px-3.5 py-3">
              <p className="m-0 whitespace-pre-wrap break-words text-[13px] leading-[1.55] text-[#454254]">{note.body}</p>
              <div className="mt-1.5 flex items-center justify-between gap-2">
                <span className="text-[10px] text-muted">{formatTimestamp(note.createdAt)}</span>
                <button
                  type="button"
                  onClick={() => void removeNote(note.id)}
                  className="border-0 bg-transparent p-0 text-[10px] font-bold text-muted hover:text-red"
                >
                  Delete
                </button>
              </div>
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}

/** The same notes in a dialog, for pages without a lead side panel. */
export function LeadNotesModal({
  leadId,
  title,
  onClose,
  onChanged,
}: {
  leadId: number;
  title: string;
  onClose: () => void;
  onChanged?: () => void;
}) {
  useEffect(() => {
    function handleKey(event: KeyboardEvent) {
      if (event.key === "Escape") onClose();
    }
    window.addEventListener("keydown", handleKey);
    return () => window.removeEventListener("keydown", handleKey);
  }, [onClose]);

  return (
    <div className="fixed inset-0 z-40 flex items-center justify-center p-4">
      <button type="button" aria-label="Close notes" onClick={onClose} className="absolute inset-0 bg-ink/25 backdrop-blur-[1px]" />
      <section
        role="dialog"
        aria-modal="true"
        aria-label={`Notes for ${title}`}
        className="relative flex max-h-[85vh] w-full max-w-[480px] flex-col rounded-[20px] bg-white shadow-panel"
      >
        <div className="flex items-start justify-between gap-3 border-b border-line px-6 py-5">
          <div className="min-w-0">
            <h2 className="m-0 text-[15px] tracking-[-0.01em]">Notes</h2>
            <p className="m-0 truncate text-[12px] text-muted">{title} · also shows on this lead in the CRM</p>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="grid size-8 flex-none place-items-center rounded-lg text-muted hover:bg-[#f4f3f8] hover:text-ink"
          >
            <CloseIcon />
          </button>
        </div>
        <div className="overflow-y-auto px-6 py-5">
          <LeadNotes key={leadId} leadId={leadId} onChanged={onChanged} />
        </div>
      </section>
    </div>
  );
}
