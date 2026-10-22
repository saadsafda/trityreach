import { promises as fs } from "node:fs";
import path from "node:path";
import { DATA_DIR, writeTextAtomic } from "@/lib/storage";
import {
  BUILT_IN_STORE_TYPES,
  CUSTOM_STORE_COLORS,
  singularize,
  type StoreTypeDef,
} from "@/lib/store-types";

/** Server-side: the user's store-type additions/removals, merged with the
 * built-ins. scrape_leads.py reads the same file (load_store_types). */

const CATALOG_PATH = path.join(DATA_DIR, "store-types.json");

type SavedCatalog = {
  custom: { key: string; label: string; singular: string; color: string; queries: string[] }[];
  hidden: string[];
};

async function readSaved(): Promise<SavedCatalog> {
  try {
    const raw = JSON.parse(await fs.readFile(CATALOG_PATH, "utf8")) as Partial<SavedCatalog>;
    return {
      custom: Array.isArray(raw.custom) ? raw.custom : [],
      hidden: Array.isArray(raw.hidden) ? raw.hidden.map(String) : [],
    };
  } catch {
    return { custom: [], hidden: [] };
  }
}

async function writeSaved(saved: SavedCatalog): Promise<void> {
  await writeTextAtomic(CATALOG_PATH, JSON.stringify(saved, null, 2));
}

/** Every store type, built-in first, with `hidden` set on removed built-ins. */
export async function readStoreCatalog(): Promise<StoreTypeDef[]> {
  const saved = await readSaved();
  const hidden = new Set(saved.hidden);
  return [
    ...BUILT_IN_STORE_TYPES.map((type) => ({ ...type, hidden: hidden.has(type.key) })),
    ...saved.custom.map((type) => ({
      key: type.key,
      label: type.label,
      singular: type.singular,
      color: type.color,
      hint: `Your store type — searches “${type.queries.join("”, “")}”`,
      queries: type.queries,
      custom: true,
      hidden: false,
    })),
  ];
}

function slug(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "").slice(0, 40);
}

export async function addStoreType(labelValue: string, queriesValue: string[]): Promise<StoreTypeDef> {
  const label = labelValue.trim().replace(/\s+/g, " ");
  if (label.length < 2 || label.length > 40) throw new Error("The store type name must be 2–40 characters.");
  const queries = [
    ...new Set(
      (queriesValue.length ? queriesValue : [singularize(label)])
        .map((query) => query.trim().replace(/\s+/g, " ").toLowerCase())
        .filter(Boolean),
    ),
  ];
  if (!queries.length) throw new Error("Add at least one search phrase, e.g. “smoke shop”.");
  if (queries.length > 5) throw new Error("Use at most 5 search phrases per store type.");
  if (queries.some((query) => query.length < 3 || query.length > 60 || query.includes("|"))) {
    throw new Error("Each search phrase must be 3–60 characters.");
  }

  const saved = await readSaved();
  const all = await readStoreCatalog();
  if (all.some((type) => type.label.toLowerCase() === label.toLowerCase())) {
    throw new Error(`“${label}” already exists${all.find((type) => type.label.toLowerCase() === label.toLowerCase())?.hidden ? " (removed — restore it instead)" : ""}.`);
  }
  let key = `custom_${slug(label) || "type"}`;
  for (let suffix = 2; all.some((type) => type.key === key); suffix += 1) key = `custom_${slug(label)}_${suffix}`;

  const type = {
    key,
    label,
    singular: singularize(label),
    color: CUSTOM_STORE_COLORS[saved.custom.length % CUSTOM_STORE_COLORS.length],
    queries,
  };
  saved.custom.push(type);
  await writeSaved(saved);
  return { ...type, hint: "", custom: true, hidden: false };
}

/** Built-ins are hidden (restorable); the user's own types are deleted. */
export async function removeStoreType(key: string): Promise<void> {
  const saved = await readSaved();
  if (saved.custom.some((type) => type.key === key)) {
    saved.custom = saved.custom.filter((type) => type.key !== key);
  } else if (BUILT_IN_STORE_TYPES.some((type) => type.key === key)) {
    if (!saved.hidden.includes(key)) saved.hidden.push(key);
  } else {
    throw new Error("Unknown store type.");
  }
  await writeSaved(saved);
}

export async function restoreStoreType(key: string): Promise<void> {
  const saved = await readSaved();
  saved.hidden = saved.hidden.filter((hidden) => hidden !== key);
  await writeSaved(saved);
}
