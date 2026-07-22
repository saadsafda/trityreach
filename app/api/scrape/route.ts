import { spawn } from "node:child_process";
import { closeSync, openSync } from "node:fs";
import path from "node:path";
import { NextResponse } from "next/server";
import {
  ACTIVITY_PATH,
  LOG_PATH,
  ROOT_DIR,
  STATUS_PATH,
  URLS_PATH,
  ensureDataDirectory,
  isProcessRunning,
  readStatus,
  writeStatus,
  writeSearchPreferences,
} from "@/lib/storage";
import type { JobStatus } from "@/lib/types";

export const runtime = "nodejs";

function normalizeSearch(queryValue: unknown, limitValue: unknown, sourceValue: unknown) {
  if (typeof queryValue !== "string") throw new Error("Enter a lead search query.");
  const query = queryValue.trim().replace(/\s+/g, " ");
  if (query.length < 3) throw new Error("The search query must contain at least 3 characters.");
  if (query.length > 200) throw new Error("The search query must be 200 characters or fewer.");
  const limit = Number(limitValue);
  if (!Number.isInteger(limit) || limit < 1 || limit > 25) {
    throw new Error("The result limit must be between 1 and 25.");
  }
  const source: "web" | "maps" = sourceValue === "maps" ? "maps" : "web";
  return { query, limit, source };
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
    const body = (await request.json()) as { query?: unknown; limit?: unknown; source?: unknown };
    const search = normalizeSearch(body.query, body.limit, body.source);
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
    await writeSearchPreferences(search);
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
    logDescriptor = openSync(LOG_PATH, "a");
    const child = spawn(
      pythonPath,
      [
        path.join(ROOT_DIR, "scrape_leads.py"),
        "--query",
        search.query,
        "--source",
        search.source,
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
        env: process.env,
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
