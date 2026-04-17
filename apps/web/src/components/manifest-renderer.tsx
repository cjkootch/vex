import type { ManifestPanel, ViewManifest } from "@vex/ui";

/**
 * Render a typed ViewManifest. Each panel type maps to a small dedicated
 * component. The component never accepts raw HTML — every value is rendered
 * as text inside React elements.
 */
export function ManifestRenderer({ manifest }: { manifest: ViewManifest }) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
      {manifest.panels.map((panel, i) => (
        <Panel key={i} panel={panel} />
      ))}
    </div>
  );
}

function Panel({ panel }: { panel: ManifestPanel }) {
  switch (panel.type) {
    case "profile":
      return (
        <section data-panel="profile">
          <h2>{panel.objectType}</h2>
          <dl>
            {Object.entries(panel.fields).map(([k, v]) => (
              <div key={k}>
                <dt style={{ fontWeight: 600 }}>{k}</dt>
                <dd>{v}</dd>
              </div>
            ))}
          </dl>
        </section>
      );
    case "table":
      return (
        <section data-panel="table">
          <h2>{panel.title}</h2>
          <table>
            <thead>
              <tr>
                {panel.columns.map((c) => (
                  <th key={c}>{c}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {panel.rows.map((row, ri) => (
                <tr key={ri}>
                  {panel.columns.map((c) => (
                    <td key={c}>{row[c] ?? ""}</td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      );
    case "timeline":
      return (
        <section data-panel="timeline">
          <h2>{panel.title}</h2>
          <ol>
            {panel.events.map((e, i) => (
              <li key={i}>
                <strong>{e.occurred_at}</strong> — <em>{e.verb}</em> — {e.summary}
                <span style={{ color: "#888" }}> ({e.source})</span>
              </li>
            ))}
          </ol>
        </section>
      );
    case "kpi_rail":
      return (
        <section
          data-panel="kpi_rail"
          style={{ display: "flex", gap: 16, flexWrap: "wrap" }}
        >
          {panel.metrics.map((m, i) => (
            <div key={i} style={{ minWidth: 120 }}>
              <div style={{ color: "#888", fontSize: 12 }}>{m.label}</div>
              <div style={{ fontSize: 20, fontWeight: 600 }}>
                {m.value}
                {m.unit ? ` ${m.unit}` : ""}
              </div>
              {m.delta && (
                <div style={{ fontSize: 12 }}>
                  {m.trend === "up" ? "▲" : m.trend === "down" ? "▼" : "—"} {m.delta}
                </div>
              )}
            </div>
          ))}
        </section>
      );
    case "evidence":
      return (
        <section data-panel="evidence">
          <h2>Evidence</h2>
          <ul>
            {panel.items.map((item) => (
              <li key={item.chunk_id}>
                <code>{item.chunk_id}</code> — {item.source_ref} (
                {item.occurred_at ?? "unknown"}, {item.freshness_hours.toFixed(1)}h old,
                conf {item.confidence_score.toFixed(2)})
              </li>
            ))}
          </ul>
        </section>
      );
    case "graph":
      return (
        <section data-panel="graph">
          <h2>Graph</h2>
          <div style={{ color: "#888", fontSize: 12 }}>
            {panel.nodes.length} nodes, {panel.edges.length} edges
          </div>
          <ul>
            {panel.nodes.map((n) => (
              <li key={n.id}>
                <strong>{n.label}</strong> ({n.objectType})
              </li>
            ))}
          </ul>
        </section>
      );
    case "campaign":
      return (
        <section data-panel="campaign">
          <h2>Campaign {panel.campaignId}</h2>
          <table>
            <tbody>
              <tr>
                <th>Sent</th>
                <td>{panel.sent}</td>
              </tr>
              <tr>
                <th>Delivered</th>
                <td>{panel.delivered}</td>
              </tr>
              <tr>
                <th>Opened (weak)</th>
                <td>{panel.opened}</td>
              </tr>
              <tr>
                <th>Clicked</th>
                <td>{panel.clicked}</td>
              </tr>
              <tr>
                <th>Bounced</th>
                <td>{panel.bounced}</td>
              </tr>
              <tr>
                <th>Click rate</th>
                <td>{(panel.click_rate * 100).toFixed(1)}%</td>
              </tr>
              <tr>
                <th>Open rate</th>
                <td>
                  {(panel.open_rate * 100).toFixed(1)}% (open_confidence: {panel.open_confidence})
                </td>
              </tr>
            </tbody>
          </table>
        </section>
      );
    case "voice_session":
      return (
        <section data-panel="voice_session">
          <h2>Voice call</h2>
          <div style={{ color: "#888", fontSize: 12 }}>
            {panel.sessionId} · {panel.durationSeconds}s · {panel.status}
          </div>
          <p>{panel.summary}</p>
          <div style={{ fontSize: 12 }}>
            {panel.actionItemsCount} action item{panel.actionItemsCount === 1 ? "" : "s"}
          </div>
        </section>
      );
  }
}
