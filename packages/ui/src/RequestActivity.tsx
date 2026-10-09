import { useEffect, useState, type ReactNode } from "react";
import type { RequestActivityApi } from "@pythia-software/query-table-react";

export interface RequestActivityProps {
  activity: RequestActivityApi;
  /** Optional host diagnostics, e.g. database and network timings. */
  children?: ReactNode;
  id?: string;
}
export function RequestActivity({
  activity,
  children,
  id,
}: RequestActivityProps) {
  const pending = activity.entries.filter((e) => e.status === "pending").length;
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (!pending) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 250);
    return () => clearInterval(timer);
  }, [pending]);
  return (
    <section
      id={id}
      className="qt-request-activity"
      aria-label="Request activity"
    >
      <div className="qt-request-activity-head">
        <strong>Request activity</strong>
        <span role="status">{pending} pending</span>
        <button type="button" className="qt-btn" onClick={activity.clear}>
          Clear completed
        </button>
      </div>
      {activity.entries.length ? (
        <div className="qt-request-activity-scroll">
          <table>
            <thead>
              <tr>
                <th>Request</th>
                <th>State</th>
                <th>Elapsed</th>
                <th>Details</th>
              </tr>
            </thead>
            <tbody>
              {activity.entries.map((e) => (
                <tr key={e.id} data-status={e.status}>
                  <td>
                    #{e.id} {e.kind}
                  </td>
                  <td>{e.status}</td>
                  <td>
                    {Math.round(
                      e.durationMs ?? Math.max(0, now - e.startedAt),
                    ).toLocaleString()}{" "}
                    ms
                  </td>
                  <td>{e.error ?? "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <p className="qt-muted">
          No requests recorded. Client data is evaluated locally.
        </p>
      )}
      {children}
    </section>
  );
}
