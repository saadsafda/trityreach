import { promises as fs } from "node:fs";
import path from "node:path";
import { DATA_DIR, writeTextAtomic } from "@/lib/storage";

/** US ZIP code → centre point + town name, via OpenStreetMap Nominatim
 * (free; 1 request/second, identifying User-Agent, cache everything). Used to
 * label ZIP chips on the dashboard and to hand the scraper exact coordinates
 * for a ZIP search, so Google Maps can be restricted to that area. */

const CACHE_PATH = path.join(DATA_DIR, "zip-cache.json");
const USER_AGENT = "TrityReach-LeadMap/1.0 (local lead dashboard)";

export type ZipArea = { zip: string; lat: number; lng: number; label: string };

export const ZIP_RE = /^\d{5}$/;

export function isZip(value: string): boolean {
  return ZIP_RE.test(value.trim());
}

const zipState = globalThis as typeof globalThis & {
  __trityZip?: { cache: Record<string, ZipArea | null> | null; chain: Promise<unknown>; lastAt: number };
};
const state = (zipState.__trityZip ??= { cache: null, chain: Promise.resolve(), lastAt: 0 });

async function loadCache(): Promise<Record<string, ZipArea | null>> {
  if (state.cache) return state.cache;
  try {
    state.cache = JSON.parse(await fs.readFile(CACHE_PATH, "utf8")) as Record<string, ZipArea | null>;
  } catch {
    state.cache = {};
  }
  return state.cache;
}

async function fetchZip(zip: string): Promise<ZipArea | null> {
  // Space requests ≥ 1.1 s apart, per Nominatim's usage policy.
  const wait = state.lastAt + 1_100 - Date.now();
  if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
  state.lastAt = Date.now();
  const url = `https://nominatim.openstreetmap.org/search?${new URLSearchParams({
    postalcode: zip,
    countrycodes: "us",
    format: "jsonv2",
    addressdetails: "1",
    limit: "1",
  })}`;
  const response = await fetch(url, {
    headers: { "User-Agent": USER_AGENT, Accept: "application/json" },
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) throw new Error(`ZIP lookup failed (HTTP ${response.status}).`);
  const [hit] = (await response.json()) as {
    lat?: string;
    lon?: string;
    address?: Record<string, string>;
  }[];
  if (!hit?.lat || !hit.lon || (hit.address?.postcode && hit.address.postcode !== zip)) return null;
  const address = hit.address ?? {};
  const town = address.city || address.town || address.village || address.hamlet || address.suburb || address.county || "";
  const stateCode = (address["ISO3166-2-lvl4"] || "").replace(/^US-/, "");
  return { zip, lat: Number(hit.lat), lng: Number(hit.lon), label: [town, stateCode].filter(Boolean).join(", ") };
}

/** Resolve a 5-digit US ZIP (cached forever; null = no such ZIP). */
export async function resolveZip(value: string): Promise<ZipArea | null> {
  const zip = value.trim();
  if (!isZip(zip)) return null;
  const cache = await loadCache();
  if (zip in cache) return cache[zip];
  // One lookup at a time across concurrent requests.
  const run = state.chain.then(async () => {
    if (zip in cache) return cache[zip];
    const area = await fetchZip(zip);
    cache[zip] = area;
    await writeTextAtomic(CACHE_PATH, JSON.stringify(cache, null, 2));
    return area;
  });
  state.chain = run.catch(() => undefined);
  return run;
}
