"use client";

import { driver } from "driver.js";
import { usePathname } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";
import { HelpIcon } from "@/components/icons";
import { TOUR_SEEN_KEY, stepsForPage } from "@/lib/tour";
import "driver.js/dist/driver.css";

/** Anchors render after the first data fetch resolves, so wait for one before auto-starting. */
const AUTOSTART_DELAY_MS = 900;

export default function TourGuide() {
  const pathname = usePathname();
  const [ready, setReady] = useState(false);
  const startedRef = useRef(false);

  const startTour = useCallback(() => {
    const steps = stepsForPage(pathname);
    if (!steps.length) return;

    const tour = driver({
      steps,
      showProgress: true,
      allowClose: true,
      overlayColor: "#17152b",
      overlayOpacity: 0.6,
      stagePadding: 6,
      stageRadius: 16,
      popoverClass: "trity-tour",
      progressText: "{{current}} of {{total}}",
      nextBtnText: "Next",
      prevBtnText: "Back",
      doneBtnText: "Done",
      onDestroyed: () => {
        try {
          window.localStorage.setItem(TOUR_SEEN_KEY, "1");
        } catch {
          // Private browsing or blocked storage — the tour just offers itself again next visit.
        }
      },
    });

    tour.drive();
  }, [pathname]);

  // Mount gate: the button is client-only, and auto-start needs the page's anchors present.
  useEffect(() => {
    const timer = window.setTimeout(() => setReady(true), AUTOSTART_DELAY_MS);
    return () => window.clearTimeout(timer);
  }, []);

  useEffect(() => {
    if (!ready || startedRef.current) return;
    startedRef.current = true;
    let seen = true;
    try {
      seen = window.localStorage.getItem(TOUR_SEEN_KEY) === "1";
    } catch {
      // Storage unavailable — skip auto-start rather than replaying the tour on every load.
    }
    if (!seen) startTour();
  }, [ready, startTour]);

  return (
    <button
      type="button"
      onClick={startTour}
      data-tour="guide-button"
      title="Take a guided tour of TrityReach"
      className="inline-flex h-[34px] flex-none items-center gap-1.5 rounded-[10px] border border-[#dcdbe5] bg-white px-3 text-[12px] font-bold text-[#3f3d4d] transition-colors hover:border-indigo hover:text-indigo"
    >
      <HelpIcon />
      <span className="hidden sm:inline">Guide</span>
    </button>
  );
}
