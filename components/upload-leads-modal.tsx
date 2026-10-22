"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { CloseIcon, UploadIcon } from "@/components/icons";
import { IMPORT_TARGETS, guessMapping, rowToLead, type ColumnMapping, type ImportTarget } from "@/lib/lead-columns";
import type { ImportSummary } from "@/lib/types";
import { useStoreCatalog } from "@/lib/use-store-catalog";

type Parsed = {
  fileName: string;
  headers: string[];
  rows: string[][];
  totalRows: number;
  truncated: boolean;
  firstRowNumber: number;
};

type Step = "pick" | "map" | "done";

/** Upload a CSV / Excel lead list: pick a file → check the column matching
 * (guessed from the headers) → import. Valid, new leads are saved as manual
 * leads; duplicates (in the file, CRM, or ERP) and incomplete rows are
 * skipped and reported. Nothing is called or emailed automatically. */
export default function UploadLeadsModal({
  erpConnected,
  onClose,
  onImported,
}: {
  erpConnected: boolean;
  onClose: () => void;
  /** Called after an import so the lead list can refresh. */
  onImported: () => void;
}) {
  const [step, setStep] = useState<Step>("pick");
  const [parsed, setParsed] = useState<Parsed | null>(null);
  const [mapping, setMapping] = useState<ColumnMapping | null>(null);
  const [defaultStoreType, setDefaultStoreType] = useState("");
  const [skipErp, setSkipErp] = useState(erpConnected);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [summary, setSummary] = useState<ImportSummary | null>(null);
  const [syncNote, setSyncNote] = useState("");
  const [dragging, setDragging] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);
  const { types: storeCatalog } = useStoreCatalog();

  useEffect(() => {
    function handleKey(event: KeyboardEvent) {
      if (event.key === "Escape" && !busy) onClose();
    }
    window.addEventListener("keydown", handleKey);
    return () => window.removeEventListener("keydown", handleKey);
  }, [onClose, busy]);

  async function readFile(file: File) {
    setError("");
    setBusy(true);
    try {
      const form = new FormData();
      form.append("file", file);
      const response = await fetch("/api/leads/upload", { method: "POST", body: form });
      const payload = (await response.json()) as Parsed & { error?: string };
      if (!response.ok) throw new Error(payload.error || "Could not read that file");
      setParsed(payload);
      setMapping(guessMapping(payload.headers));
      setStep("map");
    } catch (readError) {
      setError(readError instanceof Error ? readError.message : "Could not read that file");
    } finally {
      setBusy(false);
    }
  }

  const leads = useMemo(
    (): Record<string, string>[] =>
      parsed && mapping
        ? parsed.rows.map((row, index) => ({
            ...rowToLead(row, mapping, { store_type: defaultStoreType }),
            _row: String(parsed.firstRowNumber + index),
          }))
        : [],
    [parsed, mapping, defaultStoreType],
  );

  const ready = Boolean(mapping && mapping.business_name >= 0 && (mapping.phone >= 0 || mapping.email >= 0));

  async function importLeads() {
    if (!parsed) return;
    setError("");
    setBusy(true);
    try {
      const response = await fetch("/api/leads/import", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ leads, skipErp: erpConnected && skipErp, fileName: parsed.fileName }),
      });
      const payload = (await response.json()) as ImportSummary & { error?: string };
      if (!response.ok) throw new Error(payload.error || "Could not import the leads");
      setSummary(payload);
      setStep("done");
      onImported();
    } catch (importError) {
      setError(importError instanceof Error ? importError.message : "Could not import the leads");
    } finally {
      setBusy(false);
    }
  }

  async function syncToErp() {
    setBusy(true);
    setSyncNote("");
    try {
      const response = await fetch("/api/erpnext/sync", { method: "POST" });
      const payload = (await response.json()) as { created?: number; skipped?: number; failed?: unknown[]; error?: string };
      if (!response.ok) throw new Error(payload.error || "Could not sync with ERP");
      setSyncNote(
        `Saved ${payload.created ?? 0} lead(s) to ERP` +
          (payload.failed?.length ? ` · ${payload.failed.length} failed (see the activity feed)` : "."),
      );
    } catch (syncError) {
      setSyncNote(syncError instanceof Error ? syncError.message : "Could not sync with ERP");
    } finally {
      setBusy(false);
    }
  }

  function setColumn(target: ImportTarget, column: number) {
    setMapping((current) => (current ? { ...current, [target]: column } : current));
  }

  const preview = leads.slice(0, 5);

  return (
    <div className="fixed inset-0 z-[1000] flex items-center justify-center p-4">
      <button type="button" aria-label="Close" onClick={() => !busy && onClose()} className="absolute inset-0 bg-ink/25 backdrop-blur-[1px]" />
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Upload leads"
        className="relative flex max-h-[92vh] w-full max-w-[860px] flex-col rounded-[20px] border border-line bg-white shadow-panel"
      >
        <div className="flex items-start justify-between gap-3 border-b border-line px-6 py-5">
          <div>
            <h2 className="m-0 mb-1 text-[17px] tracking-[-0.02em]">Upload leads</h2>
            <p className="m-0 text-[12px] text-muted">
              {step === "pick" && "A CSV or Excel (.xlsx) file with one lead per row and column names in the first row."}
              {step === "map" && parsed && `${parsed.fileName} · ${parsed.totalRows.toLocaleString()} row(s) — check how the columns were matched.`}
              {step === "done" && parsed && `Finished importing ${parsed.fileName}.`}
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            disabled={busy}
            aria-label="Close"
            className="grid size-8 flex-none place-items-center rounded-lg text-muted hover:bg-[#f4f3f8] hover:text-ink"
          >
            <CloseIcon />
          </button>
        </div>

        <div className="flex-1 overflow-y-auto px-6 py-5">
          {error && (
            <p className="mt-0 mb-4 rounded-xl border border-[#ffd5dc] bg-[#fff5f6] px-3.5 py-2.5 text-[12px] text-[#9e3043]" role="alert">
              {error}
            </p>
          )}

          {step === "pick" && (
            <>
              <button
                type="button"
                onClick={() => fileInput.current?.click()}
                onDragOver={(event) => {
                  event.preventDefault();
                  setDragging(true);
                }}
                onDragLeave={() => setDragging(false)}
                onDrop={(event) => {
                  event.preventDefault();
                  setDragging(false);
                  const file = event.dataTransfer.files[0];
                  if (file) void readFile(file);
                }}
                disabled={busy}
                className={`flex w-full flex-col items-center justify-center gap-2 rounded-2xl border-2 border-dashed px-6 py-12 text-center transition-colors ${
                  dragging ? "border-indigo bg-indigo-soft" : "border-[#d8d6e2] bg-[#fbfbfd] hover:border-indigo"
                }`}
              >
                <span className="grid size-12 place-items-center rounded-2xl bg-indigo-soft text-indigo">
                  {busy ? (
                    <span className="size-4 animate-spin-fast rounded-full border-2 border-indigo/25 border-t-indigo" />
                  ) : (
                    <UploadIcon />
                  )}
                </span>
                <strong className="text-[14px] text-ink">{busy ? "Reading the file…" : "Drop a file here, or click to choose"}</strong>
                <span className="text-[12px] text-muted">.csv or .xlsx · up to 5 MB · up to 5,000 leads per file</span>
              </button>
              <input
                ref={fileInput}
                type="file"
                accept=".csv,.xlsx,.tsv,.txt"
                className="hidden"
                onChange={(event) => {
                  const file = event.target.files?.[0];
                  if (file) void readFile(file);
                  event.target.value = "";
                }}
              />
              <p className="mt-4 mb-0 text-[12px] leading-[1.6] text-muted">
                Columns are matched automatically from names like <em>Company</em>, <em>Store Name</em>, <em>Phone</em>,{" "}
                <em>Email</em>, <em>Address</em>, <em>City</em>, <em>State</em>, <em>ZIP</em> — you can change any match
                before importing. Each lead needs a business name and a phone or email.
              </p>
            </>
          )}

          {step === "map" && parsed && mapping && (
            <>
              {parsed.truncated && (
                <p className="mt-0 mb-4 rounded-xl bg-[#fef4e6] px-3.5 py-2.5 text-[12px] text-[#8a520a]">
                  This file has {parsed.totalRows.toLocaleString()} rows — the first 5,000 will be imported. Upload the rest
                  as a second file.
                </p>
              )}
              <div className="grid grid-cols-1 gap-x-5 gap-y-2.5 sm:grid-cols-2">
                {IMPORT_TARGETS.map((target) => (
                  <label key={target.key} className="flex items-center justify-between gap-3">
                    <span className="text-[12px] font-bold text-[#464353]">
                      {target.label}
                      {"required" in target && target.required && <span className="text-red"> *</span>}
                    </span>
                    <select
                      value={mapping[target.key]}
                      onChange={(event) => setColumn(target.key, Number(event.target.value))}
                      className={`h-[36px] w-[210px] rounded-[9px] border bg-white px-2 text-[12px] outline-none focus:border-indigo ${
                        mapping[target.key] >= 0 ? "border-indigo/40 font-semibold text-ink" : "border-[#d8d6e2] text-muted"
                      }`}
                    >
                      <option value={-1}>— Not in file —</option>
                      {parsed.headers.map((header, index) => (
                        <option key={`${header}-${index}`} value={index}>
                          {header}
                        </option>
                      ))}
                    </select>
                  </label>
                ))}
              </div>

              <div className="mt-5 flex flex-wrap items-center gap-x-6 gap-y-3 rounded-2xl bg-[#fbfbfd] px-4 py-3">
                <label className="flex items-center gap-2 text-[12px] font-bold text-[#464353]">
                  {mapping.store_type >= 0 ? "Store type when the column is empty:" : "Store type for every lead:"}
                  <select
                    value={defaultStoreType}
                    onChange={(event) => setDefaultStoreType(event.target.value)}
                    className="h-[34px] rounded-[9px] border border-[#d8d6e2] bg-white px-2 text-[12px] outline-none focus:border-indigo"
                  >
                    <option value="">None</option>
                    {storeCatalog
                      .filter((type) => !type.hidden)
                      .map((type) => (
                        <option key={type.key} value={type.singular}>
                          {type.singular}
                        </option>
                      ))}
                  </select>
                </label>
                {erpConnected && (
                  <label className="flex cursor-pointer items-center gap-2 text-[12px] font-bold text-[#464353]">
                    <input type="checkbox" checked={skipErp} onChange={(event) => setSkipErp(event.target.checked)} className="size-4 accent-indigo" />
                    Skip leads already in ERP
                  </label>
                )}
              </div>

              <strong className="mt-5 mb-2 block text-[10px] font-extrabold uppercase tracking-[0.1em] text-[#8a879a]">
                Preview (first {preview.length} of {leads.length.toLocaleString()})
              </strong>
              <div className="overflow-x-auto rounded-xl border border-line">
                <table className="w-full border-collapse text-left text-[11px]">
                  <thead className="bg-[#fbfbfd] text-[#8a879a]">
                    <tr>
                      {["Business", "Contact", "Phone", "Email", "Address", "Store type"].map((label) => (
                        <th key={label} className="px-3 py-2 font-bold whitespace-nowrap">
                          {label}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {preview.map((lead) => (
                      <tr key={lead._row} className="border-t border-line">
                        {[lead.business_name, lead.contact_name, lead.phone, lead.email, lead.address, lead.store_type].map((value, index) => (
                          <td key={index} className={`max-w-[180px] truncate px-3 py-2 ${value ? "text-ink" : "text-[#c2c0cc]"}`}>
                            {value || "—"}
                          </td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              {!ready && (
                <p className="mt-3 mb-0 text-[12px] text-[#9e3043]">
                  Match at least <strong>Business name</strong> and a <strong>Phone</strong> or <strong>Email</strong> column to import.
                </p>
              )}
            </>
          )}

          {step === "done" && summary && (
            <>
              <div className="grid grid-cols-2 gap-2.5 sm:grid-cols-4">
                {(
                  [
                    { label: "Imported", value: summary.imported, tone: "bg-green-soft text-green" },
                    { label: "Already in CRM", value: summary.alreadyInCrm, tone: "bg-[#f1f0f5] text-[#696777]" },
                    { label: "Already in ERP", value: summary.alreadyInErp, tone: "bg-indigo-soft text-indigo" },
                    { label: "Skipped rows", value: summary.duplicatesInFile + summary.invalidCount, tone: "bg-[#fef4e6] text-[#8a520a]" },
                  ] as const
                ).map((card) => (
                  <div key={card.label} className={`rounded-2xl px-4 py-3 ${card.tone}`}>
                    <strong className="block text-[24px] leading-tight tracking-[-0.03em]">{card.value.toLocaleString()}</strong>
                    <span className="text-[11px] font-bold">{card.label}</span>
                  </div>
                ))}
              </div>
              {(summary.duplicatesInFile > 0 || summary.invalidCount > 0) && (
                <p className="mt-3 mb-0 text-[12px] text-muted">
                  {summary.duplicatesInFile > 0 && `${summary.duplicatesInFile} row(s) repeated a lead already in the file. `}
                  {summary.invalidCount > 0 && `${summary.invalidCount} row(s) were incomplete:`}
                </p>
              )}
              {summary.invalid.length > 0 && (
                <ul className="mt-2 mb-0 flex max-h-[220px] list-none flex-col gap-1 overflow-y-auto rounded-xl border border-line p-2 text-[11px]">
                  {summary.invalid.map((item) => (
                    <li key={item.row} className="flex gap-3 rounded-lg px-2 py-1.5 odd:bg-[#fbfbfd]">
                      <span className="w-[54px] flex-none font-bold text-muted">Row {item.row}</span>
                      <span className="w-[180px] flex-none truncate text-ink">{item.business || "(no name)"}</span>
                      <span className="text-[#9e3043]">{item.reason}</span>
                    </li>
                  ))}
                  {summary.invalidCount > summary.invalid.length && (
                    <li className="px-2 py-1.5 text-muted">…and {summary.invalidCount - summary.invalid.length} more.</li>
                  )}
                </ul>
              )}
              <p className="mt-4 mb-0 text-[12px] text-muted">
                Uploaded leads now appear in the CRM and on the map. No calls or emails were sent — use the Call / Email
                buttons when you&apos;re ready.
              </p>
              {syncNote && <p className="mt-2 mb-0 rounded-xl bg-indigo-soft px-3 py-2 text-[12px] text-indigo">{syncNote}</p>}
            </>
          )}
        </div>

        <div className="flex flex-wrap items-center justify-between gap-3 border-t border-line bg-[#fbfbfd] px-6 py-4">
          {step === "map" ? (
            <button
              type="button"
              onClick={() => {
                setStep("pick");
                setParsed(null);
                setMapping(null);
              }}
              disabled={busy}
              className="text-[12px] font-bold text-muted hover:text-indigo"
            >
              ← Choose a different file
            </button>
          ) : (
            <span />
          )}
          <div className="flex items-center gap-2">
            {step === "done" && erpConnected && summary && summary.imported > 0 && !syncNote && (
              <button
                type="button"
                onClick={() => void syncToErp()}
                disabled={busy}
                className="inline-flex h-10 items-center gap-2 rounded-[11px] border border-[#dcdbe5] bg-white px-4 text-[12px] font-bold text-[#3f3d4d] hover:border-indigo hover:text-indigo"
              >
                {busy ? "Saving to ERP…" : "Save new leads to ERP"}
              </button>
            )}
            {step === "map" ? (
              <button
                type="button"
                onClick={() => void importLeads()}
                disabled={busy || !ready}
                className="inline-flex h-10 items-center gap-2 rounded-[11px] border border-indigo bg-indigo px-5 text-[12px] font-bold text-white shadow-button disabled:opacity-50"
              >
                {busy && <span className="size-3.5 animate-spin-fast rounded-full border-2 border-white/35 border-t-white" />}
                {busy ? "Importing…" : `Import ${leads.length.toLocaleString()} lead(s)`}
              </button>
            ) : (
              <button
                type="button"
                onClick={onClose}
                disabled={busy}
                className="inline-flex h-10 items-center rounded-[11px] border border-indigo bg-indigo px-5 text-[12px] font-bold text-white"
              >
                {step === "done" ? "Done" : "Cancel"}
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
