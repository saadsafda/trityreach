"use client";

import { useEffect, useState } from "react";
import { CloseIcon, PlusIcon } from "@/components/icons";
import { singularize, type StoreTypeDef } from "@/lib/store-types";

/** Add your own store types and remove (or restore) built-in ones. Changes
 * are saved to data/store-types.json, which the scraper reads too. */
export default function StoreTypesModal({
  types,
  onChange,
  onClose,
}: {
  types: StoreTypeDef[];
  /** Called with the updated catalog after every successful change. */
  onChange: (types: StoreTypeDef[]) => void;
  onClose: () => void;
}) {
  const [label, setLabel] = useState("");
  const [phrases, setPhrases] = useState("");
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");

  useEffect(() => {
    function handleKey(event: KeyboardEvent) {
      if (event.key === "Escape") onClose();
    }
    window.addEventListener("keydown", handleKey);
    return () => window.removeEventListener("keydown", handleKey);
  }, [onClose]);

  async function send(body: Record<string, unknown>, busyKey: string): Promise<boolean> {
    setError("");
    setBusy(busyKey);
    try {
      const response = await fetch("/api/store-types", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const payload = (await response.json()) as { types?: StoreTypeDef[]; error?: string };
      if (!response.ok || !payload.types) throw new Error(payload.error || "Could not update store types");
      onChange(payload.types);
      return true;
    } catch (sendError) {
      setError(sendError instanceof Error ? sendError.message : "Could not update store types");
      return false;
    } finally {
      setBusy("");
    }
  }

  async function add(event: React.FormEvent) {
    event.preventDefault();
    const queries = phrases
      .split(/[,\n]/)
      .map((phrase) => phrase.trim())
      .filter(Boolean);
    if (await send({ action: "add", label, queries }, "add")) {
      setLabel("");
      setPhrases("");
    }
  }

  const active = types.filter((type) => !type.hidden);
  const removed = types.filter((type) => type.hidden);
  const previewQueries = (phrases.trim() ? phrases.split(/[,\n]/) : [label ? singularize(label).toLowerCase() : ""])
    .map((phrase) => phrase.trim())
    .filter(Boolean);

  return (
    <div className="fixed inset-0 z-[1000] flex items-center justify-center p-4">
      <button type="button" aria-label="Close" onClick={onClose} className="absolute inset-0 bg-ink/25 backdrop-blur-[1px]" />
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Manage store types"
        className="relative flex max-h-[90vh] w-full max-w-[600px] flex-col rounded-[20px] border border-line bg-white shadow-panel"
      >
        <div className="flex items-start justify-between gap-3 border-b border-line px-6 py-5">
          <div>
            <h2 className="m-0 mb-1 text-[17px] tracking-[-0.02em]">Store types</h2>
            <p className="m-0 text-[12px] text-muted">
              Add the kinds of stores you sell to, or remove ones you don&apos;t. Each type is searched on Google Maps with
              its phrases in every city.
            </p>
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

        <div className="flex-1 overflow-y-auto px-6 py-5">
          <form onSubmit={add} className="mb-6 rounded-2xl border border-[#e6e5ec] bg-[#fbfbfd] p-4">
            <strong className="mb-3 block text-[13px]">Add a store type</strong>
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <label className="flex flex-col gap-1.5">
                <span className="text-[11px] font-bold text-[#464353]">Name (plural)</span>
                <input
                  value={label}
                  onChange={(event) => setLabel(event.target.value)}
                  placeholder="e.g. Smoke shops"
                  maxLength={40}
                  className="h-[40px] rounded-[10px] border border-[#d8d6e2] bg-white px-3 text-[13px] outline-none focus:border-indigo"
                />
              </label>
              <label className="flex flex-col gap-1.5">
                <span className="text-[11px] font-bold text-[#464353]">Google search phrases (comma-separated)</span>
                <input
                  value={phrases}
                  onChange={(event) => setPhrases(event.target.value)}
                  placeholder="smoke shop, vape shop, tobacco store"
                  className="h-[40px] rounded-[10px] border border-[#d8d6e2] bg-white px-3 text-[13px] outline-none focus:border-indigo"
                />
              </label>
            </div>
            <div className="mt-3 flex flex-wrap items-center justify-between gap-3">
              <p className="m-0 text-[11px] text-muted">
                {label.trim()
                  ? `Searches “${previewQueries.join("”, “")}” in each city · leads tagged “${singularize(label)}”`
                  : "More phrases = more stores found (each phrase returns up to 60 per city)."}
              </p>
              <button
                type="submit"
                disabled={busy === "add" || label.trim().length < 2}
                className="inline-flex h-9 items-center gap-1.5 rounded-[10px] border border-indigo bg-indigo px-3.5 text-[12px] font-bold text-white disabled:opacity-50"
              >
                <PlusIcon /> {busy === "add" ? "Adding…" : "Add"}
              </button>
            </div>
          </form>

          {error && (
            <p className="mt-0 mb-4 rounded-xl border border-[#ffd5dc] bg-[#fff5f6] px-3.5 py-2.5 text-[12px] text-[#9e3043]" role="alert">
              {error}
            </p>
          )}

          <strong className="mb-2 block text-[10px] font-extrabold uppercase tracking-[0.1em] text-[#8a879a]">
            In use ({active.length})
          </strong>
          <ul className="m-0 mb-5 flex list-none flex-col gap-1.5 p-0">
            {active.map((type) => (
              <li key={type.key} className="flex items-center gap-3 rounded-xl border border-[#f0eff4] px-3 py-2.5">
                <span className="size-3 flex-none rounded-full" style={{ background: type.color }} />
                <span className="min-w-0 flex-1">
                  <span className="flex items-center gap-2 text-[13px] font-bold text-ink">
                    {type.label}
                    {type.custom && (
                      <span className="rounded-full bg-indigo-soft px-2 py-0.5 text-[9px] font-bold text-indigo">Yours</span>
                    )}
                  </span>
                  <span className="block truncate text-[11px] text-muted">Searches: {type.queries.join(", ")}</span>
                </span>
                <button
                  type="button"
                  disabled={Boolean(busy) || active.length <= 1}
                  onClick={() => {
                    if (type.custom && !window.confirm(`Delete “${type.label}”? Leads already tagged with it are kept.`)) return;
                    void send({ action: "remove", key: type.key }, type.key);
                  }}
                  title={active.length <= 1 ? "Keep at least one store type" : type.custom ? "Delete this store type" : "Remove from the list (you can restore it)"}
                  className="flex-none rounded-lg border border-[#e6e5ec] px-2.5 py-1.5 text-[11px] font-bold text-[#9e3043] hover:border-[#f3b8c3] disabled:opacity-40"
                >
                  {busy === type.key ? "…" : type.custom ? "Delete" : "Remove"}
                </button>
              </li>
            ))}
          </ul>

          {removed.length > 0 && (
            <>
              <strong className="mb-2 block text-[10px] font-extrabold uppercase tracking-[0.1em] text-[#8a879a]">
                Removed ({removed.length})
              </strong>
              <ul className="m-0 flex list-none flex-col gap-1.5 p-0">
                {removed.map((type) => (
                  <li key={type.key} className="flex items-center gap-3 rounded-xl border border-dashed border-[#e6e5ec] px-3 py-2.5 opacity-80">
                    <span className="size-3 flex-none rounded-full border-2" style={{ borderColor: type.color }} />
                    <span className="min-w-0 flex-1 text-[13px] font-semibold text-muted">{type.label}</span>
                    <button
                      type="button"
                      disabled={Boolean(busy)}
                      onClick={() => void send({ action: "restore", key: type.key }, type.key)}
                      className="flex-none rounded-lg border border-[#e6e5ec] px-2.5 py-1.5 text-[11px] font-bold text-indigo hover:border-indigo"
                    >
                      {busy === type.key ? "…" : "Restore"}
                    </button>
                  </li>
                ))}
              </ul>
            </>
          )}
        </div>

        <div className="flex justify-end border-t border-line bg-[#fbfbfd] px-6 py-4">
          <button
            type="button"
            onClick={onClose}
            className="inline-flex h-10 items-center rounded-[11px] border border-indigo bg-indigo px-5 text-[12px] font-bold text-white"
          >
            Done
          </button>
        </div>
      </div>
    </div>
  );
}
