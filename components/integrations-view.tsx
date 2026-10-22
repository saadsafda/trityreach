"use client";

import { useCallback, useEffect, useState } from "react";
import AppShell from "@/components/app-shell";
import { BuildingIcon, PlugIcon } from "@/components/icons";
import type { ErpNextStatus } from "@/lib/types";

const INPUT_CLASS =
  "h-[44px] rounded-[10px] border border-[#d8d6e2] bg-white px-3 text-[13px] text-ink outline-none transition-shadow placeholder:text-[#aaa8b6] focus:border-indigo focus:shadow-[0_0_0_3px_rgba(91,79,233,0.09)] disabled:bg-[#f7f7fa]";

function Toggle({
  checked,
  onChange,
  label,
  description,
}: {
  checked: boolean;
  onChange: (value: boolean) => void;
  label: string;
  description: string;
}) {
  return (
    <label className="flex cursor-pointer items-start justify-between gap-4 rounded-2xl border border-[#f0eff4] bg-[#fbfbfd] p-4">
      <span className="flex flex-col gap-0.5">
        <strong className="text-[13px] text-ink">{label}</strong>
        <span className="text-[12px] leading-[1.5] text-muted">{description}</span>
      </span>
      <input
        type="checkbox"
        role="switch"
        checked={checked}
        onChange={(event) => onChange(event.target.checked)}
        className="peer sr-only"
      />
      <span
        aria-hidden="true"
        className={`relative mt-0.5 h-6 w-11 flex-none rounded-full transition-colors peer-focus-visible:ring-2 peer-focus-visible:ring-indigo/40 ${
          checked ? "bg-indigo" : "bg-[#d8d6e2]"
        }`}
      >
        <span
          className={`absolute top-0.5 size-5 rounded-full bg-white shadow transition-transform ${
            checked ? "translate-x-[22px]" : "translate-x-0.5"
          }`}
        />
      </span>
    </label>
  );
}

export default function IntegrationsView() {
  const [status, setStatus] = useState<ErpNextStatus | null>(null);
  const [url, setUrl] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [apiSecret, setApiSecret] = useState("");
  const [saveLeads, setSaveLeads] = useState(true);
  const [skipExisting, setSkipExisting] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  const applyStatus = useCallback((next: ErpNextStatus) => {
    setStatus(next);
    setUrl(next.url);
    setApiKey("");
    setApiSecret("");
    setSaveLeads(next.saveLeads);
    setSkipExisting(next.skipExisting);
  }, []);

  useEffect(() => {
    void (async () => {
      try {
        const response = await fetch("/api/erpnext", { cache: "no-store" });
        const payload = (await response.json()) as { erpnext: ErpNextStatus };
        applyStatus(payload.erpnext);
      } catch {
        setError("Could not load the ERP connection.");
      }
    })();
  }, [applyStatus]);

  const connected = Boolean(status?.connected);

  async function save(event: React.FormEvent) {
    event.preventDefault();
    setError("");
    setNotice("");
    setSaving(true);
    try {
      const response = await fetch("/api/erpnext", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        // Blank key/secret on an existing connection means "keep the saved ones";
        // the server only accepts that when the site URL is unchanged.
        body: JSON.stringify({
          url,
          apiKey,
          apiSecret,
          saveLeads,
          skipExisting,
        }),
      });
      const payload = (await response.json()) as { erpnext?: ErpNextStatus; error?: string };
      if (!response.ok || !payload.erpnext) throw new Error(payload.error || "Could not connect to ERP");
      applyStatus(payload.erpnext);
      setNotice(connected ? "Settings saved — connection re-tested successfully." : `Connected as ${payload.erpnext.user}.`);
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : "Could not connect to ERP");
    } finally {
      setSaving(false);
    }
  }

  async function disconnect() {
    if (!window.confirm("Disconnect ERP? New scrapes will stop saving to and checking against it.")) return;
    setError("");
    setNotice("");
    const response = await fetch("/api/erpnext", { method: "DELETE" });
    const payload = (await response.json()) as { erpnext: ErpNextStatus };
    applyStatus(payload.erpnext);
    setNotice("ERP disconnected.");
  }

  return (
    <AppShell isActive={false}>
      <div className="mx-auto w-full max-w-[1240px] px-5 py-10 md:px-9 md:py-14">
        <section className="mb-8 max-w-[640px] px-2">
          <div className="mb-4 flex items-center gap-2 text-[12px] font-extrabold uppercase tracking-[0.14em] text-indigo">
            Integrations
          </div>
          <h1 className="m-0 text-[clamp(32px,3.6vw,46px)] font-bold leading-[1.02] tracking-[-0.04em]">
            Connect your <span className="text-indigo">ERP.</span>
          </h1>
          <p className="mt-4 max-w-[560px] text-[15px] leading-[1.7] text-muted">
            Every new lead TrityReach finds is saved straight into your ERP — and anyone already in it is
            filtered out before they&apos;re scraped or contacted.
          </p>
        </section>

        <section className="grid grid-cols-1 items-start gap-5 lg:grid-cols-[minmax(0,1fr)_minmax(300px,0.7fr)]">
          <article className="overflow-hidden rounded-[20px] border border-line bg-white shadow-panel">
            <div className="flex flex-wrap items-center justify-between gap-3 border-b border-line px-6 py-5">
              <div className="flex items-center gap-3">
                <span className="grid size-[42px] flex-none place-items-center rounded-2xl bg-indigo-soft text-indigo">
                  <PlugIcon />
                </span>
                <div>
                  <h2 className="m-0 text-[17px] tracking-[-0.02em]">ERP</h2>
                  <p className="m-0 text-[12px] text-muted">Frappe-based ERP, version 13 and later</p>
                </div>
              </div>
              <span
                className={`flex items-center gap-1.5 rounded-full px-2.5 py-1.5 text-[10px] font-extrabold uppercase tracking-[0.1em] ${
                  connected ? "bg-green-soft text-green" : "bg-[#f1f0f5] text-[#696777]"
                }`}
              >
                <span className="size-1.5 rounded-full bg-current" />
                {status === null ? "Loading" : connected ? "Connected" : "Not connected"}
              </span>
            </div>

            <form onSubmit={save} className="flex flex-col gap-5 px-6 py-6">
              {connected && status && (
                <div className="flex items-center gap-2.5 rounded-xl bg-green-soft px-4 py-3 text-[12px] text-green">
                  <BuildingIcon />
                  <span>
                    Connected to <strong>{status.url}</strong> as <strong>{status.user}</strong>
                    {status.connectedAt && ` · since ${new Date(status.connectedAt).toLocaleDateString()}`}
                  </span>
                </div>
              )}

              <div className="grid grid-cols-1 gap-3.5 sm:grid-cols-2">
                <label className="flex flex-col gap-1.5 sm:col-span-2">
                  <span className="text-[11px] font-bold text-[#464353]">
                    Site URL <span className="text-red">*</span>
                  </span>
                  <input
                    value={url}
                    onChange={(event) => setUrl(event.target.value)}
                    placeholder="https://yourcompany.erpnext.com"
                    autoComplete="off"
                    className={INPUT_CLASS}
                  />
                </label>
                <label className="flex flex-col gap-1.5">
                  <span className="text-[11px] font-bold text-[#464353]">
                    API key {!connected && <span className="text-red">*</span>}
                  </span>
                  <input
                    value={apiKey}
                    onChange={(event) => setApiKey(event.target.value)}
                    placeholder={connected ? `Saved (${status?.apiKeyHint})` : "e.g. 3f1c9a0b2d7e4f5"}
                    autoComplete="off"
                    className={INPUT_CLASS}
                  />
                </label>
                <label className="flex flex-col gap-1.5">
                  <span className="text-[11px] font-bold text-[#464353]">
                    API secret {!connected && <span className="text-red">*</span>}
                  </span>
                  <input
                    type="password"
                    value={apiSecret}
                    onChange={(event) => setApiSecret(event.target.value)}
                    placeholder={connected ? "Saved — leave blank to keep" : "••••••••••••"}
                    autoComplete="new-password"
                    className={INPUT_CLASS}
                  />
                </label>
              </div>

              <div className="flex flex-col gap-2.5">
                <Toggle
                  checked={skipExisting}
                  onChange={setSkipExisting}
                  label="Skip leads already in ERP"
                  description="Before scraping and again after enrichment, drop any lead whose email, phone, website, or business name (same city) matches an existing Lead or Customer."
                />
                <Toggle
                  checked={saveLeads}
                  onChange={setSaveLeads}
                  label="Save new leads to ERP"
                  description="Create each new lead as a Lead in your ERP as soon as a scrape finishes — before outreach starts."
                />
              </div>

              {error && (
                <p className="m-0 rounded-xl border border-[#ffd5dc] bg-[#fff5f6] px-3.5 py-2.5 text-[12px] text-[#9e3043]" role="alert">
                  {error}
                </p>
              )}
              {notice && !error && (
                <p className="m-0 rounded-xl bg-indigo-soft px-3.5 py-2.5 text-[12px] text-indigo" role="status">
                  {notice}
                </p>
              )}

              <div className="flex flex-wrap items-center justify-end gap-2 border-t border-line pt-5">
                {connected && (
                  <button
                    type="button"
                    onClick={() => void disconnect()}
                    className="inline-flex h-10 items-center justify-center rounded-[11px] border border-[#dcdbe5] bg-white px-4 text-[12px] font-bold text-red hover:border-red"
                  >
                    Disconnect
                  </button>
                )}
                <button
                  type="submit"
                  disabled={saving || !url.trim() || (!connected && (!apiKey.trim() || !apiSecret.trim()))}
                  className="inline-flex h-10 items-center justify-center gap-2 rounded-[11px] border border-indigo bg-indigo px-5 text-[12px] font-bold text-white shadow-button transition-transform hover:enabled:-translate-y-px hover:enabled:bg-indigo-dark disabled:opacity-60"
                >
                  {saving && <span className="size-3.5 animate-spin-fast rounded-full border-2 border-white/35 border-t-white" />}
                  {saving ? "Testing connection…" : connected ? "Save changes" : "Connect ERP"}
                </button>
              </div>
            </form>
          </article>

          <aside className="rounded-[20px] border border-line bg-white p-6 shadow-panel">
            <h2 className="m-0 mb-1 text-[17px] tracking-[-0.02em]">Get your API key</h2>
            <p className="m-0 text-[12px] text-muted">Takes about a minute in your ERP.</p>
            <ol className="mt-5 flex flex-col gap-4 pl-0 text-[13px] leading-[1.55] text-[#464353]">
              {[
                <>Open <strong>User</strong> list in your ERP and pick the user TrityReach should act as (one with the <em>Sales User</em> role works).</>,
                <>Go to the <strong>Settings</strong> tab → <strong>API Access</strong> → click <strong>Generate Keys</strong>.</>,
                <>Copy the <strong>API Secret</strong> from the popup — your ERP only shows it once.</>,
                <>The <strong>API Key</strong> is shown in the same section. Paste both here with your site URL.</>,
              ].map((step, index) => (
                <li key={index} className="flex list-none gap-3">
                  <span className="grid size-6 flex-none place-items-center rounded-full bg-indigo-soft text-[11px] font-extrabold text-indigo">
                    {index + 1}
                  </span>
                  <span>{step}</span>
                </li>
              ))}
            </ol>
            <p className="mt-6 mb-0 border-t border-line pt-4 text-[11px] leading-[1.6] text-muted">
              The key and secret are stored only in this workspace (<code>data/erpnext.json</code>) and are never sent to
              the browser.
            </p>
          </aside>
        </section>
      </div>
    </AppShell>
  );
}
