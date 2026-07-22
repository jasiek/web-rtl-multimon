// Thin GA4 wrapper. gtag() is defined by the inline snippet in index.html;
// guard anyway so the app never breaks if the snippet is removed or an
// ad-blocker stubs it out.
type EventParams = Record<string, string | number | boolean | undefined>;

declare global {
  interface Window {
    gtag?: (...args: unknown[]) => void;
  }
}

// GA4 caps event parameter values at 100 characters — truncate defensively.
const clamp = (v: string) => (v.length > 100 ? v.slice(0, 100) : v);

export function track(event: string, params?: EventParams): void {
  if (typeof window.gtag !== "function") return;
  const clean: EventParams = {};
  for (const [k, v] of Object.entries(params ?? {})) {
    if (v === undefined) continue;
    clean[k] = typeof v === "string" ? clamp(v) : v;
  }
  window.gtag("event", event, clean);
}
