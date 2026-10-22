"use client";

import "leaflet/dist/leaflet.css";
import "leaflet.markercluster/dist/MarkerCluster.css";
import "leaflet.markercluster/dist/MarkerCluster.Default.css";
import type * as Leaflet from "leaflet";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import AppShell from "@/components/app-shell";
import { DownloadIcon, SearchIcon } from "@/components/icons";
import { OTHER_STORE_COLOR, storeTypeColor, type StoreTypeDef } from "@/lib/store-types";
import { useStoreCatalog } from "@/lib/use-store-catalog";
import type { MapPoint, MapState } from "@/lib/types";

/** The question the map answers first: is this lead new, or already known? */
type LeadStatus = "latest" | "existing";
type ColorMode = "status" | "type";

const STATUS_META: Record<LeadStatus, { label: string; short: string; color: string; soft: string; hint: string }> = {
  latest: {
    label: "Latest leads",
    short: "New",
    color: "#16a34a",
    soft: "#e3f5ea",
    hint: "Found by your most recent search",
  },
  existing: {
    label: "Already in ERP",
    short: "In ERP",
    color: "#5b4fe9",
    soft: "#eceaff",
    hint: "Leads saved before the latest search (or added by hand)",
  },
};

const OTHER = "Other";

function statusOf(point: MapPoint): LeadStatus {
  return point.inRun ? "latest" : "existing";
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function typeOf(point: MapPoint): string {
  return point.store_type || OTHER;
}

function pinColor(point: MapPoint, mode: ColorMode, types: StoreTypeDef[]): string {
  return mode === "status" ? STATUS_META[statusOf(point)].color : storeTypeColor(point.store_type, types);
}

function formatWhen(iso: string): string {
  if (!iso) return "";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleString([], { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
}

/** Popup body: built as an HTML string because Leaflet owns popup DOM. */
function popupHtml(point: MapPoint, types: StoreTypeDef[]): string {
  const status = STATUS_META[statusOf(point)];
  const rows = [
    point.address || point.city ? `<div>${escapeHtml(point.address || point.city)}</div>` : "",
    point.approximate ? `<div style="color:#b26b0c">Approximate — placed at the city centre</div>` : "",
    point.contact_name ? `<div>Contact: ${escapeHtml(point.contact_name)}</div>` : "",
    point.phone ? `<div><a href="tel:${escapeHtml(point.phone)}">${escapeHtml(point.phone)}</a></div>` : "",
    point.email ? `<div><a href="mailto:${escapeHtml(point.email)}">${escapeHtml(point.email)}</a></div>` : "",
    point.website
      ? `<div><a href="${escapeHtml(point.website)}" target="_blank" rel="noreferrer">${escapeHtml(
          point.website.replace(/^https?:\/\//, "").replace(/\/$/, ""),
        )}</a></div>`
      : "",
  ].join("");
  // What the status means for this particular lead.
  const statusLine =
    statusOf(point) === "latest"
      ? point.erpName
        ? `New from the latest search · saved to ERP as ${escapeHtml(point.erpName)}`
        : "New from the latest search · not in ERP"
      : point.erpName
        ? `Already in ERP as ${escapeHtml(point.erpName)}${point.createdAt ? ` · since ${escapeHtml(formatWhen(point.createdAt))}` : ""}`
        : "Added by hand · not in ERP";
  const directions = `https://www.google.com/maps/dir/?api=1&destination=${point.lat},${point.lng}`;
  return `<div class="tr-popup">
    <span class="tr-status" style="background:${status.soft};color:${status.color}">
      <span style="background:${status.color}"></span>${statusOf(point) === "latest" ? "Latest lead" : status.label}
    </span>
    <div class="tr-popup-type" style="color:${storeTypeColor(point.store_type, types)}">${escapeHtml(typeOf(point))}</div>
    <strong class="tr-popup-name">${escapeHtml(point.business_name || "Unnamed lead")}</strong>
    <div class="tr-popup-rows">${rows}</div>
    <div class="tr-popup-foot"><span class="tr-popup-note">${statusLine}</span><a href="${directions}" target="_blank" rel="noreferrer">Directions ↗</a></div>
  </div>`;
}

function pinIcon(L: typeof Leaflet, point: MapPoint, mode: ColorMode, types: StoreTypeDef[]): Leaflet.DivIcon {
  const color = pinColor(point, mode, types);
  const latest = statusOf(point) === "latest";
  const size = latest ? 18 : 13;
  const fill = point.approximate
    ? `background:#fff;border:3px dashed ${color};`
    : `background:${color};border:${latest ? 3 : 2}px solid #fff;`;
  return L.divIcon({
    className: `tr-pin${latest ? " tr-pin-latest" : ""}`,
    html: `<span class="tr-pin-dot" style="--pin:${color};width:${size}px;height:${size}px;${fill}"></span>`,
    iconSize: [size, size],
    iconAnchor: [size / 2, size / 2],
    popupAnchor: [0, -size / 2],
  });
}

/** Cluster bubble as a pie: green share = latest leads, indigo = already in
 * ERPNext — so new leads stand out before you zoom in. */
function clusterIcon(L: typeof Leaflet, cluster: Leaflet.MarkerCluster): Leaflet.DivIcon {
  const children = cluster.getAllChildMarkers();
  const latest = children.filter((marker) => (marker.options as { status?: LeadStatus }).status === "latest").length;
  const total = children.length;
  const share = Math.round((latest / total) * 360);
  const size = total < 10 ? 34 : total < 100 ? 40 : 48;
  const ring = `conic-gradient(${STATUS_META.latest.color} 0deg ${share}deg, ${STATUS_META.existing.color} ${share}deg 360deg)`;
  const title = latest ? `${latest} latest · ${total - latest} in ERP` : `${total} in ERP`;
  return L.divIcon({
    className: "tr-cluster",
    html: `<span class="tr-cluster-ring" style="width:${size}px;height:${size}px;background:${ring}" title="${title}">
      <span class="tr-cluster-count">${total}</span>
    </span>`,
    iconSize: [size, size],
  });
}

export default function MapView() {
  const [data, setData] = useState<MapState | null>(null);
  const [error, setError] = useState("");
  const [hiddenStatuses, setHiddenStatuses] = useState<Set<LeadStatus>>(new Set());
  const [hiddenTypes, setHiddenTypes] = useState<Set<string>>(new Set());
  const [colorMode, setColorMode] = useState<ColorMode>("status");
  const [search, setSearch] = useState("");
  const mapElement = useRef<HTMLDivElement>(null);
  const leaflet = useRef<{ L: typeof Leaflet; map: Leaflet.Map; cluster: Leaflet.MarkerClusterGroup } | null>(null);
  const markers = useRef(new Map<string, Leaflet.Marker>());
  const fitted = useRef(false);
  const [mapReady, setMapReady] = useState(false);
  const { types: storeCatalog } = useStoreCatalog();

  const fetchData = useCallback(async () => {
    try {
      const response = await fetch("/api/map", { cache: "no-store" });
      const payload = (await response.json()) as MapState & { error?: string };
      if (!response.ok) throw new Error(payload.error || "Could not load the lead map");
      setData(payload);
      setError(payload.erp.error ? `ERP: ${payload.erp.error}` : "");
    } catch (fetchError) {
      setError(fetchError instanceof Error ? fetchError.message : "Could not load the lead map");
    }
  }, []);

  // Poll quickly while addresses are being located, slowly otherwise (new runs).
  const pending = data?.geocodePending ?? 0;
  useEffect(() => {
    const initial = window.setTimeout(() => void fetchData(), 0);
    const interval = window.setInterval(() => void fetchData(), pending > 0 ? 4000 : 30000);
    return () => {
      window.clearTimeout(initial);
      window.clearInterval(interval);
    };
  }, [fetchData, pending]);

  // Leaflet touches `window`, so it's loaded on the client only.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const L = (await import("leaflet")).default;
      // leaflet.markercluster extends the global L.
      (window as unknown as { L: typeof Leaflet }).L = L;
      await import("leaflet.markercluster");
      if (cancelled || !mapElement.current || leaflet.current) return;
      const map = L.map(mapElement.current, { zoomControl: true, worldCopyJump: true }).setView([39.5, -98.35], 4);
      // OpenStreetMap's own tiles: free, no API key, fine for a team dashboard
      // (its tile policy asks for attribution and no bulk downloading).
      L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
        maxZoom: 19,
        className: "tr-tiles",
        attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
      }).addTo(map);
      const cluster = L.markerClusterGroup({
        showCoverageOnHover: false,
        maxClusterRadius: 45,
        spiderfyOnMaxZoom: true,
        iconCreateFunction: (group) => clusterIcon(L, group),
      });
      map.addLayer(cluster);
      leaflet.current = { L, map, cluster };
      setMapReady(true);
    })();
    return () => {
      cancelled = true;
      leaflet.current?.map.remove();
      leaflet.current = null;
    };
  }, []);

  const points = useMemo(() => data?.points ?? [], [data]);

  const statusCounts = useMemo(() => {
    const counts: Record<LeadStatus, number> = { latest: 0, existing: 0 };
    for (const point of points) counts[statusOf(point)] += 1;
    return counts;
  }, [points]);

  const typeCounts = useMemo(() => {
    const counts = new Map<string, number>();
    for (const point of points) counts.set(typeOf(point), (counts.get(typeOf(point)) ?? 0) + 1);
    return counts;
  }, [points]);

  const legend = useMemo(() => {
    const known = storeCatalog.filter((type) => typeCounts.has(type.singular)).map((type) => ({
      label: type.singular,
      color: type.color,
    }));
    const extra = [...typeCounts.keys()]
      .filter((label) => label !== OTHER && !storeCatalog.some((type) => type.singular === label))
      .map((label) => ({ label, color: OTHER_STORE_COLOR }));
    const other = typeCounts.has(OTHER) ? [{ label: OTHER, color: OTHER_STORE_COLOR }] : [];
    return [...known, ...extra, ...other];
  }, [typeCounts, storeCatalog]);

  const visible = useMemo(() => {
    const needle = search.trim().toLowerCase();
    return points
      .filter((point) => !hiddenStatuses.has(statusOf(point)))
      .filter((point) => !hiddenTypes.has(typeOf(point)))
      .filter(
        (point) =>
          !needle ||
          [point.business_name, point.city, point.address, point.phone, point.email, point.store_type, point.erpName]
            .join(" ")
            .toLowerCase()
            .includes(needle),
      )
      .sort((a, b) => Number(b.inRun) - Number(a.inRun) || (b.createdAt || "").localeCompare(a.createdAt || ""));
  }, [points, hiddenStatuses, hiddenTypes, search]);

  // Sync markers with the visible list.
  useEffect(() => {
    const current = leaflet.current;
    if (!current || !mapReady) return;
    const { L, map, cluster } = current;
    cluster.clearLayers();
    markers.current.clear();
    const layers = visible.map((point) => {
      const marker = L.marker([point.lat, point.lng], {
        icon: pinIcon(L, point, colorMode, storeCatalog),
        title: point.business_name,
        // Latest leads sit on top of older ones at the same spot.
        zIndexOffset: point.inRun ? 1000 : 0,
      });
      (marker.options as { status?: LeadStatus }).status = statusOf(point);
      marker.bindPopup(popupHtml(point, storeCatalog), { maxWidth: 290 });
      markers.current.set(point.id, marker);
      return marker;
    });
    cluster.addLayers(layers);
    if (!fitted.current && layers.length) {
      fitted.current = true;
      map.fitBounds(L.latLngBounds(visible.map((point) => [point.lat, point.lng])), { padding: [40, 40], maxZoom: 13 });
    }
  }, [visible, mapReady, colorMode, storeCatalog]);

  function focus(point: MapPoint) {
    const current = leaflet.current;
    const marker = markers.current.get(point.id);
    if (!current || !marker) return;
    current.cluster.zoomToShowLayer(marker, () => marker.openPopup());
  }

  function fitTo(subset: MapPoint[]) {
    const current = leaflet.current;
    if (!current || !subset.length) return;
    current.map.fitBounds(current.L.latLngBounds(subset.map((point) => [point.lat, point.lng])), {
      padding: [40, 40],
      maxZoom: 14,
    });
  }

  function toggleStatus(status: LeadStatus) {
    setHiddenStatuses((current) => {
      const next = new Set(current);
      if (next.has(status)) next.delete(status);
      else next.add(status);
      return next;
    });
  }

  const latestVisible = visible.filter((point) => point.inRun);
  const approximateCount = visible.filter((point) => point.approximate).length;
  const latestWhen = formatWhen(data?.latestRun.at ?? "");

  return (
    <AppShell isActive={false}>
      <div className="mx-auto w-full max-w-[1400px] px-5 py-8 md:px-9 md:py-10">
        <section className="mb-6 flex flex-wrap items-end justify-between gap-4 px-2">
          <div>
            <div className="mb-3 text-[12px] font-extrabold uppercase tracking-[0.14em] text-indigo">Lead map</div>
            <h1 className="m-0 text-[clamp(28px,3.2vw,40px)] font-bold leading-[1.05] tracking-[-0.04em]">
              <span style={{ color: STATUS_META.latest.color }}>New</span> leads vs.{" "}
              <span className="text-indigo">ones you already have.</span>
            </h1>
          </div>
          <p className="m-0 max-w-[420px] text-[13px] leading-[1.6] text-muted">
            Green = found by your latest search. Indigo = already in ERP. Clusters show the mix.
          </p>
        </section>

        {error && (
          <div className="mb-4 flex gap-2.5 rounded-xl border border-[#ffd5dc] bg-[#fff5f6] px-4 py-3 text-[12px] text-[#9e3043]" role="alert">
            <strong className="flex-none">Something needs attention</strong>
            <span>{error}</span>
          </div>
        )}

        <section className="grid grid-cols-1 gap-4 lg:grid-cols-[340px_minmax(0,1fr)]">
          <aside className="order-2 flex min-h-0 flex-col rounded-[20px] border border-line bg-white shadow-panel lg:order-1 lg:h-[calc(100vh-230px)] lg:min-h-[560px]">
            <div className="flex flex-col gap-4 border-b border-line p-5">
              <div className="grid grid-cols-2 gap-2" role="group" aria-label="Lead status">
                {(["latest", "existing"] as const).map((status) => {
                  const meta = STATUS_META[status];
                  const hidden = hiddenStatuses.has(status);
                  return (
                    <button
                      key={status}
                      type="button"
                      aria-pressed={!hidden}
                      onClick={() => toggleStatus(status)}
                      title={`${meta.hint} — click to ${hidden ? "show" : "hide"}`}
                      className={`flex flex-col items-start gap-1 rounded-2xl border-2 px-3.5 py-3 text-left transition-opacity ${
                        hidden ? "opacity-40" : ""
                      }`}
                      style={{ borderColor: hidden ? "#e6e5ec" : meta.color, background: hidden ? "#fff" : meta.soft }}
                    >
                      <span className="flex items-center gap-1.5 text-[11px] font-bold" style={{ color: meta.color }}>
                        <span className="size-2.5 rounded-full" style={{ background: meta.color }} />
                        {meta.label}
                      </span>
                      <strong className="text-[24px] leading-none tracking-[-0.03em] text-ink">{statusCounts[status]}</strong>
                    </button>
                  );
                })}
              </div>
              <p className="m-0 -mt-1 text-[11px] leading-[1.5] text-muted">
                {data?.latestRun.query
                  ? `Latest search: “${data.latestRun.query}”${latestWhen ? ` · ${latestWhen}` : ""}`
                  : "Run a search on the Discovery page to see latest leads here."}
              </p>

              {pending > 0 && (
                <div className="flex items-center gap-2 rounded-xl bg-indigo-soft px-3 py-2 text-[11px] font-semibold text-indigo">
                  <span className="size-3 flex-none animate-spin-fast rounded-full border-2 border-indigo/25 border-t-indigo" />
                  Locating {pending} address{pending === 1 ? "" : "es"}… (about {Math.ceil((pending * 1.1) / 60)} min, one time only)
                </div>
              )}
              {data && (data.unplaceable > 0 || approximateCount > 0) && (
                <p className="m-0 text-[11px] leading-[1.5] text-muted">
                  {approximateCount > 0 && `${approximateCount} placed at their city (no street address). `}
                  {data.unplaceable > 0 && `${data.unplaceable} can't be placed — no address or city.`}
                </p>
              )}

              <div className="flex items-center justify-between gap-2">
                <span className="text-[10px] font-extrabold uppercase tracking-[0.1em] text-[#8a879a]">Colour pins by</span>
                <div className="inline-flex gap-1 rounded-full bg-[#f3f2f8] p-1" role="group" aria-label="Colour pins by">
                  {(
                    [
                      { key: "status", label: "New vs ERP" },
                      { key: "type", label: "Store type" },
                    ] as const
                  ).map((option) => (
                    <button
                      key={option.key}
                      type="button"
                      aria-pressed={colorMode === option.key}
                      onClick={() => setColorMode(option.key)}
                      className={`rounded-full px-2.5 py-1 text-[11px] font-bold transition-colors ${
                        colorMode === option.key ? "bg-white text-indigo shadow-card" : "text-muted hover:text-ink"
                      }`}
                    >
                      {option.label}
                    </button>
                  ))}
                </div>
              </div>

              {legend.length > 0 && (
                <div className="flex flex-wrap gap-1.5" role="group" aria-label="Store types">
                  {legend.map((entry) => {
                    const hidden = hiddenTypes.has(entry.label);
                    return (
                      <button
                        key={entry.label}
                        type="button"
                        aria-pressed={!hidden}
                        onClick={() =>
                          setHiddenTypes((current) => {
                            const next = new Set(current);
                            if (hidden) next.delete(entry.label);
                            else next.add(entry.label);
                            return next;
                          })
                        }
                        className={`inline-flex items-center gap-1.5 rounded-full border border-[#e6e5ec] px-2.5 py-1 text-[11px] font-semibold transition-opacity ${
                          hidden ? "opacity-45" : "bg-white"
                        }`}
                      >
                        {colorMode === "type" && <span className="size-2.5 rounded-full" style={{ background: entry.color }} />}
                        {entry.label}
                        <span className="text-muted">{typeCounts.get(entry.label) ?? 0}</span>
                      </button>
                    );
                  })}
                </div>
              )}

              <div className="flex gap-2">
                <label className="flex h-[40px] min-w-0 flex-1 items-center gap-2 rounded-[11px] border border-[#dcdbe5] px-3 text-[#9996a5] focus-within:border-indigo">
                  <SearchIcon />
                  <input
                    value={search}
                    onChange={(event) => setSearch(event.target.value)}
                    placeholder="Search name, city, phone…"
                    aria-label="Search leads on the map"
                    className="w-full border-0 bg-transparent text-[12px] text-ink outline-none"
                  />
                </label>
                <button
                  type="button"
                  onClick={() => fitTo(latestVisible)}
                  disabled={!latestVisible.length}
                  className="flex-none rounded-[11px] border px-3 text-[11px] font-bold disabled:opacity-40"
                  style={{ borderColor: STATUS_META.latest.color, color: STATUS_META.latest.color }}
                  title="Zoom the map to the latest leads"
                >
                  Zoom to new
                </button>
              </div>
            </div>

            <ol className="m-0 flex max-h-[420px] list-none flex-col overflow-y-auto p-2 lg:max-h-none lg:flex-1">
              {visible.map((point, index) => {
                const status = statusOf(point);
                const meta = STATUS_META[status];
                const firstExisting = status === "existing" && (index === 0 || visible[index - 1].inRun);
                return (
                  <li key={point.id}>
                    {(index === 0 || firstExisting) && (
                      <div className="px-3 pt-2 pb-1 text-[10px] font-extrabold uppercase tracking-[0.1em]" style={{ color: meta.color }}>
                        {meta.label}
                      </div>
                    )}
                    <button
                      type="button"
                      onClick={() => focus(point)}
                      className="flex w-full items-start gap-2.5 rounded-xl px-3 py-2.5 text-left hover:bg-[#f6f5fa]"
                    >
                      <span
                        className="mt-1 size-2.5 flex-none rounded-full"
                        style={
                          point.approximate
                            ? { border: `2px dashed ${pinColor(point, colorMode, storeCatalog)}` }
                            : { background: pinColor(point, colorMode, storeCatalog) }
                        }
                      />
                      <span className="min-w-0 flex-1">
                        <strong className="block truncate text-[12px] text-ink">{point.business_name || "Unnamed lead"}</strong>
                        <span className="block truncate text-[11px] text-muted">
                          {[point.store_type, point.city].filter(Boolean).join(" · ") || point.address}
                        </span>
                      </span>
                      <span
                        className="flex-none rounded-full px-2 py-0.5 text-[9px] font-bold"
                        style={{ background: meta.soft, color: meta.color }}
                      >
                        {meta.short}
                      </span>
                    </button>
                  </li>
                );
              })}
              {data && !visible.length && (
                <li className="px-3 py-8 text-center text-[12px] text-muted">
                  {points.length ? "No leads match these filters." : "No leads with a location yet — run a Store Finder search."}
                </li>
              )}
            </ol>
          </aside>

          <div className="relative order-1 overflow-hidden rounded-[20px] border border-line bg-white shadow-panel lg:order-2">
            <div ref={mapElement} className="h-[60vh] min-h-[380px] w-full lg:h-[calc(100vh-230px)] lg:min-h-[560px]" />
            <div className="absolute top-3 right-3 z-[500] flex gap-2">
              <button
                type="button"
                onClick={() => fitTo(visible)}
                className="rounded-[10px] border border-[#dcdbe5] bg-white px-3 py-2 text-[11px] font-bold text-[#3f3d4d] shadow-card hover:border-indigo hover:text-indigo"
              >
                Show all
              </button>
              <button
                type="button"
                onClick={() => void fetchData()}
                className="inline-flex items-center gap-1.5 rounded-[10px] border border-[#dcdbe5] bg-white px-3 py-2 text-[11px] font-bold text-[#3f3d4d] shadow-card hover:border-indigo hover:text-indigo"
              >
                <DownloadIcon /> Refresh
              </button>
            </div>
            {/* Map key, always visible over the map. */}
            <div className="absolute bottom-7 left-3 z-[500] flex flex-col gap-1.5 rounded-xl border border-[#e6e5ec] bg-white/95 px-3 py-2.5 text-[11px] font-semibold text-[#3f3d4d] shadow-card">
              {colorMode === "status" ? (
                <>
                  <span className="flex items-center gap-2">
                    <span className="tr-key-latest" style={{ background: STATUS_META.latest.color }} /> Latest lead
                  </span>
                  <span className="flex items-center gap-2">
                    <span className="size-2.5 rounded-full border-2 border-white" style={{ background: STATUS_META.existing.color, boxShadow: "0 0 0 1px #d8d6e2" }} />
                    Already in ERP
                  </span>
                </>
              ) : (
                <span className="text-muted">Colours = store type (see list)</span>
              )}
              <span className="flex items-center gap-2 text-muted">
                <span className="size-2.5 rounded-full border-2 border-dashed border-[#8a879a] bg-white" /> City only (approx.)
              </span>
            </div>
          </div>
        </section>
      </div>
    </AppShell>
  );
}
