import { spawn } from "node:child_process";
import { closeSync, openSync } from "node:fs";
import path from "node:path";
import { NextResponse } from "next/server";
import { erpEnvFor, readErpConfig } from "@/lib/erpnext";
import {
  ACTIVITY_PATH,
  LOG_PATH,
  ROOT_DIR,
  STATUS_PATH,
  URLS_PATH,
  ensureDataDirectory,
  isProcessRunning,
  ZIP_RADII,
  readSearchPreferences,
  readStatus,
  writeStatus,
  writeSearchPreferences,
} from "@/lib/storage";
import { readStoreCatalog } from "@/lib/store-catalog";
import { isZip, resolveZip } from "@/lib/zip";
import { storeSearchPlan, type StoreTypeDef } from "@/lib/store-types";
import type { JobStatus, SearchPreferences } from "@/lib/types";

export const runtime = "nodejs";

function normalizeSearch(body: Record<string, unknown>, catalog: StoreTypeDef[]): SearchPreferences {
  const source = body.source === "maps" || body.source === "web" ? body.source : "stores";
  const autoOutreach = body.autoOutreach === true;
  const limit = Number(body.limit);

  if (source === "stores") {
    const storeTypes = Array.isArray(body.storeTypes)
      ? [...new Set(body.storeTypes.map(String).filter((key) => catalog.some((type) => type.key === key)))]
      : [];
    if (!storeTypes.length) throw new Error("Choose at least one store type.");
    const locations = Array.isArray(body.locations)
      ? [...new Set(body.locations.map((value) => String(value).trim().replace(/\s+/g, " ")).filter((value) => value.length >= 2))]
      : [];
    if (!locations.length) throw new Error("Add at least one location, e.g. Edison, NJ.");
    if (locations.length > 20) throw new Error("Search at most 20 locations per run.");
    if (locations.some((value) => value.length > 80)) throw new Error("Each location must be under 80 characters.");
    if (locations.some((value) => value.includes("|"))) throw new Error("Locations can't contain “|”.");
    if (!Number.isInteger(limit) || limit < 1 || limit > 1000) {
      throw new Error("The store target must be between 1 and 1000.");
    }
    const labels = storeTypes.map((key) => catalog.find((type) => type.key === key)?.label ?? key);
    return {
      query: `${labels.join(", ")} in ${locations.join("; ")}`.slice(0, 200),
      limit,
      source,
      storeTypes,
      locations,
      zipRadius: ZIP_RADII.includes(Number(body.zipRadius)) ? Number(body.zipRadius) : 5,
      autoOutreach,
    };
  }

  if (typeof body.query !== "string") throw new Error("Enter a lead search query.");
  const query = body.query.trim().replace(/\s+/g, " ");
  if (query.length < 3) throw new Error("The search query must contain at least 3 characters.");
  if (query.length > 200) throw new Error("The search query must be 200 characters or fewer.");
  if (!Number.isInteger(limit) || limit < 1 || limit > 25) {
    throw new Error("The result limit must be between 1 and 25.");
  }
  return { query, limit, source, storeTypes: [], locations: [], zipRadius: 5, autoOutreach };
}

/** CLI arguments for the chosen discovery source. */
/** ZIP locations go to the scraper with their centre ("08817@40.51,-74.40")
 * so Google Maps can be restricted to the area around them. */
async function scraperLocations(locations: string[]): Promise<string[]> {
  const out: string[] = [];
  for (const location of locations) {
    if (!isZip(location)) {
      out.push(location);
      continue;
    }
    const area = await resolveZip(location);
    if (!area) throw new Error(`ZIP code ${location} wasn't found — check it and try again.`);
    out.push(`${area.zip}@${area.lat.toFixed(6)},${area.lng.toFixed(6)}`);
  }
  return out;
}

function sourceArgs(search: SearchPreferences, catalog: StoreTypeDef[], locations: string[]): string[] {
  if (search.source === "stores") {
    const selected = catalog.filter((type) => search.storeTypes.includes(type.key));
    const plan = storeSearchPlan(selected, search.locations.length, search.limit);
    return [
      "--source",
      "stores",
      "--store-types",
      search.storeTypes.join(","),
      "--locations",
      locations.join("|"),
      "--zip-radius",
      String(search.zipRadius),
      "--max-requests",
      String(plan.budget),
      // Chains buy through head office, so the Store Finder always skips them.
      "--independent-only",
    ];
  }
  return ["--query", search.query, "--source", search.source];
}

async function waitForSpawn(child: ReturnType<typeof spawn>): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    child.once("spawn", resolve);
    child.once("error", reject);
  });
}

export async function POST(request: Request) {
  let queuedStatus: JobStatus | undefined;
  let logDescriptor: number | undefined;

  try {
    const body = (await request.json()) as Record<string, unknown>;
    const catalog = await readStoreCatalog();
    const search = normalizeSearch(body, catalog);
    const locations = search.source === "stores" ? await scraperLocations(search.locations) : [];
    const existing = await readStatus();
    if (
      (existing.status === "queued" ||
        existing.status === "discovering" ||
        existing.status === "running" ||
        existing.status === "enriching") &&
      isProcessRunning(existing.pid)
    ) {
      return NextResponse.json(
        { error: "A scrape is already running. Wait for it to finish before starting another." },
        { status: 409 },
      );
    }

    await ensureDataDirectory();
    // Keep the other source's saved fields (e.g. store locations while running
    // a web search) so switching tabs doesn't wipe them.
    const previous = await readSearchPreferences();
    await writeSearchPreferences(
      search.source === "stores"
        ? { ...search, query: previous.query }
        : {
            ...search,
            storeTypes: previous.storeTypes,
            locations: previous.locations,
            zipRadius: previous.zipRadius,
          },
    );
    const jobId = crypto.randomUUID();

    queuedStatus = {
      jobId,
      status: "queued",
      currentUrl: "",
      completed: 0,
      total: 0,
      message: "Starting lead discovery",
      error: "",
      query: search.query,
      discoveredUrls: [],
      updatedAt: new Date().toISOString(),
    };
    await writeStatus(queuedStatus);

    const pythonPath =
      process.platform === "win32"
        ? path.join(ROOT_DIR, "venv", "Scripts", "python.exe")
        : path.join(ROOT_DIR, "venv", "bin", "python");
    // ERPNext credentials go in via env, not argv, so they don't show up in `ps`.
    const erpEnv = erpEnvFor(await readErpConfig());
    logDescriptor = openSync(LOG_PATH, "a");
    const child = spawn(
      pythonPath,
      [
        path.join(ROOT_DIR, "scrape_leads.py"),
        ...sourceArgs(search, catalog, locations),
        ...(search.autoOutreach ? [] : ["--no-outreach"]),
        "--max-results",
        String(search.limit),
        "--discovered-output",
        URLS_PATH,
        "--output",
        path.join(ROOT_DIR, "leads.csv"),
        "--progress-file",
        STATUS_PATH,
        "--activity-file",
        ACTIVITY_PATH,
        "--job-id",
        jobId,
      ],
      {
        cwd: ROOT_DIR,
        env: { ...process.env, ...erpEnv },
        stdio: ["ignore", logDescriptor, logDescriptor],
      },
    );
    await waitForSpawn(child);
    closeSync(logDescriptor);
    logDescriptor = undefined;

    const latestStatus = await readStatus();
    if (latestStatus.jobId === jobId && latestStatus.status === "queued") {
      queuedStatus.pid = child.pid;
      await writeStatus(queuedStatus);
    }

    child.unref();

    return NextResponse.json({ status: { ...queuedStatus, pid: child.pid } }, { status: 202 });
  } catch (error) {
    if (logDescriptor !== undefined) closeSync(logDescriptor);
    const message = error instanceof Error ? error.message : "Could not start the scraper";
    if (queuedStatus) {
      await writeStatus({
        ...queuedStatus,
        status: "failed",
        message: "Could not start the scraper",
        error: message,
        updatedAt: new Date().toISOString(),
      });
    }
    return NextResponse.json({ error: message }, { status: 400 });
  }
}
