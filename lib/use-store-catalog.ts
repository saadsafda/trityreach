"use client";

import { useCallback, useEffect, useState } from "react";
import { BUILT_IN_STORE_TYPES, type StoreTypeDef } from "@/lib/store-types";

/** The live store-type catalog (built-ins + the user's own) from
 * /api/store-types. Starts with the built-ins so the UI never renders empty. */
export function useStoreCatalog() {
  const [types, setTypes] = useState<StoreTypeDef[]>(BUILT_IN_STORE_TYPES);

  const refresh = useCallback(async () => {
    try {
      const response = await fetch("/api/store-types", { cache: "no-store" });
      if (response.ok) setTypes(((await response.json()) as { types: StoreTypeDef[] }).types);
    } catch {
      // Keep whatever we had; built-ins are a safe fallback.
    }
  }, []);

  useEffect(() => {
    const initial = window.setTimeout(() => void refresh(), 0);
    return () => window.clearTimeout(initial);
  }, [refresh]);

  return { types, setTypes, refresh };
}
