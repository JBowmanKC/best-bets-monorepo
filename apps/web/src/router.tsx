import { useCallback, useEffect, useState } from "react";

/**
 * Two-page client-side routing, hand-rolled rather than pulled in.
 *
 * Vercel rewrites every non-API path to index.html (see vercel.json) and Vite's
 * dev server does the same, so a deep link to /pick-history loads the app and
 * this hook picks the page. react-router would add a dependency and a provider
 * for what is one `useState` and a popstate listener.
 */
export type Route = "/" | "/pick-history";

const ROUTES: Route[] = ["/", "/pick-history"];

function currentRoute(): Route {
  const path = window.location.pathname.replace(/\/+$/, "") || "/";
  return (ROUTES.find(r => r === path) ?? "/") as Route;
}

export function navigate(to: Route) {
  if (to === currentRoute()) return;
  window.history.pushState({}, "", to);
  window.dispatchEvent(new PopStateEvent("popstate"));
}

export function useRoute(): Route {
  const [route, setRoute] = useState<Route>(currentRoute);

  useEffect(() => {
    const onPop = () => setRoute(currentRoute());
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, []);

  return route;
}

/** An anchor that routes client-side but still behaves like a real link. */
export function NavLink({ to, active, children }: { to: Route; active: boolean; children: React.ReactNode }) {
  const onClick = useCallback((e: React.MouseEvent<HTMLAnchorElement>) => {
    // Let the browser handle modified clicks (new tab, download, …).
    if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || e.button !== 0) return;
    e.preventDefault();
    navigate(to);
  }, [to]);

  return (
    <a
      href={to}
      onClick={onClick}
      style={{
        background:   active ? "#243450" : "#0f1623",
        border:       `1px solid ${active ? "#4a6080" : "#1e2d45"}`,
        color:        active ? "#e2e8f0" : "#4a6080",
        borderRadius: 8, padding: "7px 16px",
        fontSize: "0.78rem", fontWeight: 700,
        textDecoration: "none", cursor: "pointer",
      }}
    >
      {children}
    </a>
  );
}
