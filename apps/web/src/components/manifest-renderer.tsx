import type { ViewManifestT, ViewNodeT } from "@vex/ui";

/**
 * Render a typed ViewManifest. The component never accepts raw HTML — every
 * node is discriminated on `kind` and rendered into real React elements.
 */
export function ManifestRenderer({ manifest }: { manifest: ViewManifestT }) {
  return <Node node={manifest.root} />;
}

function Node({ node }: { node: ViewNodeT }) {
  switch (node.kind) {
    case "text":
      return <span>{node.value}</span>;
    case "heading": {
      const Tag = `h${node.level}` as const;
      return <Tag>{node.value}</Tag>;
    }
    case "stack":
      return (
        <div
          style={{
            display: "flex",
            flexDirection: node.direction === "row" ? "row" : "column",
            gap: 12,
          }}
        >
          {node.children.map((child, i) => (
            <Node key={i} node={child} />
          ))}
        </div>
      );
    case "list":
      return (
        <ul>
          {node.items.map((item, i) => (
            <li key={i}>
              <Node node={item} />
            </li>
          ))}
        </ul>
      );
    case "action":
      return (
        <button data-action-id={node.actionId} data-tier={node.tier}>
          {node.label}
        </button>
      );
    case "kv":
      return (
        <div>
          <strong>{node.label}:</strong> <span>{node.value}</span>
        </div>
      );
  }
}
