// Loads everything the compliance monitoring pages render: the control
// catalogue (manifest), the heartbeat, and the live aggregates — then builds
// the shared model. Both the overview and the policy page use it.
//
// `provenance` filters only the live aggregates (`data`); it re-loads all three
// because that is what the standalone dashboard does when the evidence-origin
// chip changes, and the model must be rebuilt against the matching heartbeat.
import { useEffect, useRef, useState } from "react";
import { fetchDashboardManifest, fetchDashboardHeartbeat, fetchDashboardData } from "./api";
import { buildModel } from "./dashboardModel";

export function useDashboard(provenance = "all") {
  const [manifest, setManifest] = useState(null);
  const [model, setModel] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const prevModel = useRef(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    (async () => {
      try {
        const [m, hb, d] = await Promise.all([
          fetchDashboardManifest(),
          fetchDashboardHeartbeat({ slim: false }),
          fetchDashboardData(provenance),
        ]);
        if (cancelled) return;
        const built = buildModel(hb, d, prevModel.current);
        prevModel.current = built;
        setManifest(m);
        setModel(built);
        setError(null);
      } catch (e) {
        if (!cancelled) setError(e.message);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [provenance]);

  return { manifest, model, loading, error };
}
