import { parse } from "csv-parse/sync";
import { NextResponse } from "next/server";

export const runtime = "nodejs";

const MAX_BYTES = 5 * 1024 * 1024;
const MAX_UPLOAD_ROWS = 5000;

/** Excel in some locales saves "CSV" with ; or tabs — pick whichever splits
 * the header line into the most columns. */
function detectDelimiter(text: string): string {
  const firstLine = text.split(/\r?\n/, 1)[0] ?? "";
  return [",", ";", "\t", "|"].reduce((best, candidate) =>
    firstLine.split(candidate).length > firstLine.split(best).length ? candidate : best,
  );
}

function parseCsv(buffer: Buffer): string[][] {
  const text = buffer.toString("utf8").replace(/^﻿/, "");
  return parse(text, {
    delimiter: detectDelimiter(text),
    relax_column_count: true,
    relax_quotes: true,
    skip_empty_lines: true,
    trim: true,
  }) as string[][];
}

async function parseXlsx(buffer: Buffer): Promise<string[][]> {
  const { default: ExcelJS } = await import("exceljs");
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(buffer as unknown as ArrayBuffer);
  // First sheet that actually has data.
  const sheet = workbook.worksheets.find((candidate) => candidate.actualRowCount > 0);
  if (!sheet) return [];
  const rows: string[][] = [];
  sheet.eachRow({ includeEmpty: false }, (row) => {
    const values: string[] = [];
    for (let column = 1; column <= sheet.actualColumnCount; column += 1) {
      values.push(row.getCell(column).text?.trim() ?? "");
    }
    rows.push(values);
  });
  return rows;
}

/** POST multipart "file" (.csv / .xlsx) → { headers, rows } for the column
 * mapping step. Nothing is saved here. */
export async function POST(request: Request) {
  try {
    const form = await request.formData();
    const file = form.get("file");
    if (!(file instanceof File)) throw new Error("Choose a CSV or Excel file to upload.");
    if (file.size > MAX_BYTES) throw new Error("That file is over 5 MB. Split it into smaller files.");
    const name = file.name.toLowerCase();
    const buffer = Buffer.from(await file.arrayBuffer());

    let table: string[][];
    if (name.endsWith(".xlsx")) table = await parseXlsx(buffer);
    else if (name.endsWith(".csv") || name.endsWith(".txt") || name.endsWith(".tsv")) table = parseCsv(buffer);
    else if (name.endsWith(".xls")) throw new Error("Old .xls files aren't supported — in Excel use File → Save As → .xlsx or .csv.");
    else throw new Error("Upload a .csv or .xlsx file.");

    // The header row is the first row with at least two filled cells.
    const headerIndex = table.findIndex((row) => row.filter(Boolean).length >= 2);
    if (headerIndex < 0) throw new Error("The file has no header row — the first row should name the columns.");
    const headers = table[headerIndex].map((header, index) => header || `Column ${index + 1}`);
    const body = table
      .slice(headerIndex + 1)
      .filter((row) => row.some((cell) => cell.trim()))
      .map((row) => headers.map((_, index) => row[index] ?? ""));
    if (!body.length) throw new Error("The file has a header row but no leads under it.");

    return NextResponse.json({
      fileName: file.name,
      headers,
      rows: body.slice(0, MAX_UPLOAD_ROWS),
      totalRows: body.length,
      truncated: body.length > MAX_UPLOAD_ROWS,
      // Spreadsheet row number of the first data row, for error messages.
      firstRowNumber: headerIndex + 2,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Could not read that file";
    return NextResponse.json({ error: message }, { status: 400 });
  }
}
