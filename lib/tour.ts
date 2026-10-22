import type { DriveStep } from "driver.js";

/** Bumped when the tour content changes materially, so returning users see the new walkthrough once. */
export const TOUR_VERSION = "2";
export const TOUR_SEEN_KEY = `trityreach.tour.seen.v${TOUR_VERSION}`;

/** Authored steps anchor by selector; steps whose anchor is missing at runtime are dropped,
 * so optional UI (empty states, breakpoint-specific nav) never leaves the tour pointing at
 * nothing. `stepsForPage` resolves the selector to a concrete element before driving. */
type AuthoredStep = Omit<DriveStep, "element"> & { element?: string };
export type TourStep = DriveStep;

const WORKFLOW_STEPS: AuthoredStep[] = [
  {
    popover: {
      title: "Welcome to TrityReach",
      description:
        "This is your lead pipeline: find businesses, enrich their contact details, then reach out. The walkthrough takes about a minute — use the arrow keys or the buttons below.",
    },
  },
  {
    element: '[data-tour="nav"]',
    popover: {
      title: "Three workspaces",
      description:
        "<b>Discovery</b> is where you search for prospects and watch the run. <b>CRM</b> is where every lead lands, with its full conversation history. <b>Integrations</b> connects your ERP, so new leads are saved there and ones you already have are skipped.",
      side: "bottom",
      align: "start",
    },
  },
  {
    element: '[data-tour="stats"]',
    popover: {
      title: "Your numbers at a glance",
      description:
        "Total leads saved to this workspace, how many have an email or phone number attached, and how many are still waiting on contact details.",
      side: "bottom",
    },
  },
  {
    element: '[data-tour="query"]',
    popover: {
      title: "Choose what you're looking for",
      description:
        "In <b>Store Finder</b>, tick the kinds of stores you sell to — supermarkets, dollar stores, convenience stores… In the other sources, type any business, e.g. <i>“Independent dentists”</i>.",
      side: "bottom",
    },
  },
  {
    element: '[data-tour="location"]',
    popover: {
      title: "…and where",
      description:
        "A city or region — Store Finder takes several (press Enter after each). Be specific: <i>“Edison, NJ”</i>, not just <i>“New Jersey”</i>.",
      side: "bottom",
    },
  },
  {
    element: '[data-tour="source"]',
    popover: {
      title: "Pick a data source",
      description:
        "<b>Store Finder</b> searches Google Maps for retail buyers and skips national chains. <b>Google Maps</b> finds any business type, including ones with no website. <b>Web Scraper</b> searches the open web for free but is less predictable.",
      side: "top",
    },
  },
  {
    element: '[data-tour="limit"]',
    popover: {
      title: "Set a lead target",
      description:
        "How many usable leads you want back. TrityReach keeps checking sources until it hits this number, so a higher target simply takes longer.",
      side: "top",
    },
  },
  {
    element: '[data-tour="run"]',
    popover: {
      title: "Discover",
      description:
        "Kicks off the run. The fields lock while it works, and results are written to <code>leads.csv</code> so they survive a restart.",
      side: "bottom",
      align: "end",
    },
  },
  {
    element: '[data-tour="progress"]',
    popover: {
      title: "Live progress",
      description:
        "The status badge moves through discovering → running → enriching → completed, with the site currently being processed shown underneath.",
      side: "top",
    },
  },
  {
    element: '[data-tour="results"]',
    popover: {
      title: "Your prospects",
      description:
        "Every lead appears here as it's found. Filter to narrow the grid, then <b>Export CSV</b> to download exactly what you're seeing.",
      side: "top",
    },
  },
  {
    element: '[data-tour="card-actions"]',
    popover: {
      title: "Reach out from the card",
      description:
        "<b>Call</b> places a real AI phone call; <b>Email</b> sends a real AI-drafted email. A button is disabled when that contact detail is missing.",
      side: "top",
    },
  },
  {
    element: '[data-tour="activity"]',
    popover: {
      title: "Live activity feed",
      description: "A running log of workflow events — discovery, enrichment, and every outreach message handed off.",
      side: "top",
    },
  },
  {
    element: '[data-tour="nav-crm"]',
    popover: {
      title: "Next: the CRM",
      description:
        "Once you have leads, head to <b>CRM</b> to contact them and read the replies. Reopen this guide any time from the <b>Guide</b> button in the header.",
      side: "bottom",
      align: "start",
    },
  },
];

const CRM_STEPS: AuthoredStep[] = [
  {
    popover: {
      title: "The CRM",
      description:
        "Every lead you've scraped lives here, alongside the exact messages, call scripts, and replies exchanged with each one.",
    },
  },
  {
    element: '[data-tour="filters"]',
    popover: {
      title: "Filter by channel",
      description:
        "Narrow to leads reached over WhatsApp, email, or call — or pick <b>Not contacted</b> to see who's still untouched.",
      side: "bottom",
    },
  },
  {
    element: '[data-tour="crm-search"]',
    popover: {
      title: "Search every field",
      description: "Matches business name, contact, email, phone, city, and website — not just the name.",
      side: "bottom",
    },
  },
  {
    element: '[data-tour="add-lead"]',
    popover: {
      title: "Add a lead by hand",
      description: "Got a lead from somewhere else? Enter it manually and it joins the same pipeline as scraped leads.",
      side: "bottom",
      align: "end",
    },
  },
  {
    element: '[data-tour="lead-row"]',
    popover: {
      title: "Anatomy of a lead",
      description:
        "Each row shows where the lead came from, its status (<b>New</b> → <b>Contacted</b> → <b>Interested</b> once they reply), and which channels have been used. Click the row to open the full conversation.",
      side: "bottom",
    },
  },
  {
    element: '[data-tour="lead-actions"]',
    popover: {
      title: "Reach out",
      description:
        "<b>Call</b> places a real AI phone call; <b>Email</b> sends a real AI-drafted email. A button is disabled when the lead is missing that contact detail.",
      side: "left",
    },
  },
  {
    element: '[data-tour="call-all"]',
    popover: {
      title: "Call everyone at once",
      description:
        "Places a real AI call to every lead with a phone number. You'll get a confirmation prompt with the count first — these are live calls.",
      side: "bottom",
      align: "end",
    },
  },
  {
    element: '[data-tour="nav-workflow"]',
    popover: {
      title: "That's the tour",
      description:
        "Head back to <b>Discovery</b> to find more prospects, or reopen this guide any time from the <b>Guide</b> button in the header.",
      side: "bottom",
      align: "start",
    },
  },
];

function isVisible(node: Element): boolean {
  return (node as HTMLElement).getClientRects().length > 0;
}

/** The nav renders twice — desktop header and mobile bottom bar — with one hidden per
 * breakpoint, so resolve each selector to the copy that's actually on screen. driver.js
 * highlights the first DOM match, which would otherwise be the hidden one. */
function resolveAnchor(selector: string): Element | null {
  const matches = Array.from(document.querySelectorAll(selector));
  return matches.find(isVisible) ?? null;
}

/** Steps for a page, minus any whose anchor isn't currently visible. Visible anchors are
 * handed to driver.js as elements rather than selectors, so the right copy is highlighted. */
export function stepsForPage(pathname: string): TourStep[] {
  const steps = pathname.startsWith("/leads") ? CRM_STEPS : WORKFLOW_STEPS;
  return steps.flatMap<TourStep>((step) => {
    if (!step.element) return [step];
    const anchor = resolveAnchor(step.element);
    return anchor ? [{ ...step, element: anchor }] : [];
  });
}
