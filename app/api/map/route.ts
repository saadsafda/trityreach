import { NextResponse } from "next/server";
import { emailKey, fetchErpLeadsForMap, nameKey, phoneKey, readErpConfig, type ErpMapLead } from "@/lib/erpnext";
import { enqueueGeocode, lookupCached } from "@/lib/geocode";
import { readManualLeads, readScrapedLeads, readStatus } from "@/lib/storage";
import type { MapPoint, MapState } from "@/lib/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** The map polls while geocoding runs; don't re-read ERPNext every poll. */
const ERP_CACHE_MS = 30_000;
const erpCache = globalThis as typeof globalThis & {
  __trityMapErp?: { at: number; url: string; leads: ErpMapLead[] };
};

type Entry = Omit<MapPoint, "lat" | "lng" | "approximate"> & {
  lat: string;
  lng: string;
  state: string;
  country: string;
};

/** Same business across the run and ERPNext: phone, else email, else name+city. */
function identity(entry: Pick<Entry, "phone" | "email" | "business_name" | "city">): string {
  const phone = phoneKey(entry.phone);
  if (phone) return `p:${phone}`;
  const email = emailKey(entry.email);
  if (email) return `e:${email}`;
  const name = nameKey(entry.business_name);
  return name ? `n:${name}|${entry.city.trim().toLowerCase()}` : "";
}

function coords(entry: Entry): { lat: number; lng: number } | null {
  const lat = Number(entry.lat);
  const lng = Number(entry.lng);
  if (!entry.lat || !entry.lng || !Number.isFinite(lat) || !Number.isFinite(lng)) return null;
  if (Math.abs(lat) > 90 || Math.abs(lng) > 180) return null;
  return { lat, lng };
}

/** "Lakewood, NJ 08701" → { city, state, zip } (US-style addresses). */
function parsePlace(address: string): { city: string; state: string; zip: string } | null {
  const match = address.match(/([A-Za-z][A-Za-z .'-]+?),?\s+([A-Z]{2})\s+(\d{5})(?:-\d{4})?\b/);
  return match ? { city: match[1].trim(), state: match[2], zip: match[3] } : null;
}

/** Geocoding queries to try, most precise first. Each one is only looked up
 * after the one before it came back "not found". */
function queriesFor(entry: Entry): { query: string; approximate: boolean }[] {
  const out: { query: string; approximate: boolean }[] = [];
  const address = entry.address.trim();
  const place = parsePlace(address);
  if (address.length >= 8) {
    out.push({ query: address, approximate: false });
    // Suite/unit numbers ("Ste 050B", "#12") often make the lookup miss.
    const bare = address.replace(/,?\s*(?:ste|suite|unit|apt|fl|floor|rm|room|#)\.?\s*[\w-]+(?=,|$)/gi, "").trim();
    if (bare !== address && bare.length >= 8) out.push({ query: bare, approximate: false });
  }
  // ZIP code: a few blocks, and unambiguous across same-named towns.
  if (place) out.push({ query: `${place.city}, ${place.state} ${place.zip}, USA`, approximate: true });
  // City centre last — with the state, so Lakewood NJ isn't put in Colorado.
  const city = entry.city.trim() || place?.city || "";
  const state = entry.state.trim() || place?.state || "";
  const country = entry.country.trim() || (place ? "USA" : "");
  if (city) out.push({ query: [city, state, country].filter(Boolean).join(", "), approximate: true });
  return out.filter((item, index, all) => all.findIndex((other) => other.query === item.query) === index);
}

export async function GET() {
  const erp: MapState["erp"] = { connected: false, count: 0, error: "" };
  const entries = new Map<string, Entry>();
  const loose: Entry[] = [];

  function add(entry: Entry) {
    const key = identity(entry);
    const existing = key ? entries.get(key) : undefined;
    if (!existing) {
      if (key) entries.set(key, entry);
      else loose.push(entry);
      return;
    }
    // Merge: keep ERPNext's name/date, fill anything the other side knows.
    existing.inRun ||= entry.inRun;
    existing.manual ||= entry.manual;
    existing.erpName ||= entry.erpName;
    existing.createdAt ||= entry.createdAt;
    for (const field of ["contact_name", "email", "phone", "website", "city", "address", "store_type", "state", "country"] as const) {
      if (!existing[field] && entry[field]) existing[field] = entry[field];
    }
    if (!coords(existing) && coords(entry)) {
      existing.lat = entry.lat;
      existing.lng = entry.lng;
    }
  }

  const config = await readErpConfig();
  if (config) {
    erp.connected = true;
    try {
      const cached = erpCache.__trityMapErp;
      const leads =
        cached && cached.url === config.url && Date.now() - cached.at < ERP_CACHE_MS
          ? cached.leads
          : await fetchErpLeadsForMap(config);
      erpCache.__trityMapErp = { at: cached?.leads === leads ? cached.at : Date.now(), url: config.url, leads };
      erp.count = leads.length;
      for (const lead of leads) {
        add({
          id: lead.name,
          business_name: lead.business_name,
          contact_name: lead.contact_name,
          email: lead.email,
          phone: lead.phone,
          website: lead.website,
          city: lead.city,
          address: lead.address,
          store_type: lead.store_type,
          lat: lead.lat,
          lng: lead.lng,
          state: lead.state,
          country: lead.country,
          inRun: false,
          manual: false,
          erpName: lead.name,
          createdAt: lead.createdAt,
        });
      }
    } catch (error) {
      erp.error = error instanceof Error ? error.message : "Could not read leads from ERP";
    }
  }

  // Latest run first, then hand-added leads (which are not "latest").
  const [scraped, manualLeads, status] = await Promise.all([readScrapedLeads(), readManualLeads(), readStatus()]);
  const runLeads = [
    ...scraped.map((lead) => ({ lead, manual: false })),
    ...manualLeads.map((lead) => ({ lead, manual: true })),
  ];
  for (const [index, { lead, manual }] of runLeads.entries()) {
    add({
      id: `${manual ? "manual" : "run"}-${index}`,
      business_name: lead.business_name,
      contact_name: lead.contact_name,
      email: lead.email,
      phone: lead.phone,
      website: lead.website,
      city: lead.city,
      address: lead.address,
      store_type: lead.store_type,
      lat: lead.lat,
      lng: lead.lng,
      state: "",
      country: "",
      inRun: !manual,
      manual,
      erpName: "",
      createdAt: "",
    });
  }

  const all = [...entries.values(), ...loose];
  const cache = await lookupCached(all.flatMap((entry) => queriesFor(entry).map((item) => item.query)));
  const points: MapPoint[] = [];
  const toGeocode: string[] = [];
  let unplaceable = 0;

  for (const entry of all) {
    const point = (lat: number, lng: number, approximate: boolean): MapPoint => ({
      id: entry.id,
      business_name: entry.business_name,
      contact_name: entry.contact_name,
      email: entry.email,
      phone: entry.phone,
      website: entry.website,
      city: entry.city,
      address: entry.address,
      store_type: entry.store_type,
      lat,
      lng,
      approximate,
      inRun: entry.inRun,
      manual: entry.manual,
      erpName: entry.erpName,
      createdAt: entry.createdAt,
    });
    const exact = coords(entry);
    if (exact) {
      points.push(point(exact.lat, exact.lng, false));
      continue;
    }
    // Street address first; the city centre only once the address is known
    // to be unfindable — so each lead costs one lookup in the common case.
    let placed = false;
    let waiting = false;
    for (const candidate of queriesFor(entry)) {
      const hit = cache.get(candidate.query);
      if (hit === undefined) {
        toGeocode.push(candidate.query);
        waiting = true;
        break;
      }
      if ("miss" in hit) continue;
      points.push(point(hit.lat, hit.lng, candidate.approximate));
      placed = true;
      break;
    }
    if (!placed && !waiting) unplaceable += 1;
  }

  const state: MapState = {
    points,
    unplaceable,
    geocodePending: toGeocode.length ? enqueueGeocode(toGeocode) : 0,
    erp,
    latestRun: { query: status.query, at: status.updatedAt, status: status.status },
  };
  return NextResponse.json(state, { headers: { "Cache-Control": "no-store" } });
}
