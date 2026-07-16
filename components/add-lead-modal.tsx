"use client";

import { useEffect, useState } from "react";
import { CloseIcon, PlusIcon } from "@/components/icons";
import type { Lead, LeadField } from "@/lib/types";

const FIELDS: { key: LeadField; label: string; placeholder: string; required?: boolean; span2?: boolean }[] = [
  { key: "business_name", label: "Business name", placeholder: "e.g. OneBeyond Retail Limited", required: true, span2: true },
  { key: "contact_name", label: "Contact person", placeholder: "e.g. Jane Smith" },
  { key: "city", label: "City", placeholder: "e.g. London" },
  { key: "email", label: "Email", placeholder: "purchasing@business.com" },
  { key: "phone", label: "Phone", placeholder: "+44 20 7946 0958" },
  { key: "website", label: "Website", placeholder: "business.com" },
  { key: "address", label: "Address", placeholder: "Street, area, postcode" },
];

const EMPTY: Lead = {
  business_name: "",
  contact_name: "",
  email: "",
  phone: "",
  website: "",
  city: "",
  address: "",
};

export default function AddLeadModal({
  onClose,
  onAdded,
}: {
  onClose: () => void;
  /** Called after the lead is saved so the list can refresh. */
  onAdded: () => void;
}) {
  const [values, setValues] = useState<Lead>(EMPTY);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    function handleKey(event: KeyboardEvent) {
      if (event.key === "Escape") onClose();
    }
    window.addEventListener("keydown", handleKey);
    return () => window.removeEventListener("keydown", handleKey);
  }, [onClose]);

  function setField(key: LeadField, value: string) {
    setValues((current) => ({ ...current, [key]: value }));
  }

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setError("");
    if (!values.business_name.trim()) {
      setError("Business name is required.");
      return;
    }
    if (!values.email.trim() && !values.phone.trim()) {
      setError("Add an email or a phone number so the lead can be contacted.");
      return;
    }
    setSaving(true);
    try {
      const response = await fetch("/api/leads", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(values),
      });
      const payload = (await response.json()) as { lead?: Lead; error?: string };
      if (!response.ok) throw new Error(payload.error || "Could not add the lead");
      onAdded();
      onClose();
    } catch (submitError) {
      setError(submitError instanceof Error ? submitError.message : "Could not add the lead");
      setSaving(false);
    }
  }

  return (
    <div className="fixed inset-0 z-30 flex items-center justify-center p-4">
      <button
        type="button"
        aria-label="Close add lead form"
        onClick={onClose}
        className="absolute inset-0 bg-ink/25 backdrop-blur-[1px]"
      />
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Add a lead"
        className="relative w-full max-w-[520px] rounded-[20px] border border-line bg-white shadow-panel"
      >
        <div className="flex items-start justify-between gap-3 border-b border-line px-6 py-5">
          <div>
            <h2 className="m-0 mb-1 text-[17px] tracking-[-0.02em]">Add a lead</h2>
            <p className="m-0 text-[12px] text-muted">
              Saved alongside scraped leads — future scrapes never overwrite it.
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

        <form onSubmit={submit}>
          <div className="grid grid-cols-2 gap-3.5 px-6 py-5">
            {FIELDS.map((field, index) => (
              <label key={field.key} className={`flex flex-col gap-1.5 ${field.span2 ? "col-span-2" : ""}`}>
                <span className="text-[11px] font-bold text-[#464353]">
                  {field.label}
                  {field.required && <span className="text-red"> *</span>}
                </span>
                <input
                  value={values[field.key]}
                  onChange={(event) => setField(field.key, event.target.value)}
                  placeholder={field.placeholder}
                  autoFocus={index === 0}
                  autoComplete="off"
                  className="h-[42px] rounded-[10px] border border-[#d8d6e2] bg-white px-3 text-[13px] text-ink outline-none transition-shadow placeholder:text-[#aaa8b6] focus:border-indigo focus:shadow-[0_0_0_3px_rgba(91,79,233,0.09)]"
                />
              </label>
            ))}
          </div>

          {error && (
            <p className="mx-6 mb-1 mt-0 rounded-xl border border-[#ffd5dc] bg-[#fff5f6] px-3.5 py-2.5 text-[12px] text-[#9e3043]" role="alert">
              {error}
            </p>
          )}

          <div className="flex items-center justify-between gap-3 border-t border-line bg-[#fbfbfd] px-6 py-4">
            <p className="m-0 text-[11px] text-muted">Needs at least an email or a phone number.</p>
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={onClose}
                className="inline-flex h-10 items-center justify-center rounded-[11px] border border-[#dcdbe5] bg-white px-4 text-[12px] font-bold text-[#3f3d4d] hover:border-indigo hover:text-indigo"
              >
                Cancel
              </button>
              <button
                type="submit"
                disabled={saving}
                className="inline-flex h-10 items-center justify-center gap-2 rounded-[11px] border border-indigo bg-indigo px-4 text-[12px] font-bold text-white shadow-button transition-transform hover:enabled:-translate-y-px hover:enabled:bg-indigo-dark"
              >
                {saving ? (
                  <span className="size-3.5 animate-spin-fast rounded-full border-2 border-white/35 border-t-white" />
                ) : (
                  <PlusIcon />
                )}
                {saving ? "Saving…" : "Add lead"}
              </button>
            </div>
          </div>
        </form>
      </div>
    </div>
  );
}
