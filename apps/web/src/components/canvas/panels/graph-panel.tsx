"use client";

import { useMemo } from "react";
import ReactFlow, { Background, Controls, type Edge, type Node } from "reactflow";
import "reactflow/dist/style.css";
import type { ManifestPanel } from "@vex/ui";

type GraphProps = Extract<ManifestPanel, { type: "graph" }>;

const TYPE_COLORS: Record<string, string> = {
  organization: "#7c5cff",
  contact: "#22c55e",
  campaign: "#f59e0b",
  lead: "#ef4444",
  default: "#6b7280",
};

function colorFor(objectType: string): string {
  return TYPE_COLORS[objectType] ?? TYPE_COLORS["default"]!;
}

export function GraphPanel({ nodes, edges }: GraphProps) {
  const flowNodes = useMemo<Node[]>(
    () =>
      nodes.map((n, i) => ({
        id: n.id,
        data: { label: n.label },
        position: layoutPosition(i, nodes.length),
        style: {
          background: colorFor(n.objectType),
          color: "white",
          border: "1px solid rgba(255,255,255,0.2)",
          borderRadius: 6,
          fontSize: 12,
          padding: 6,
        },
      })),
    [nodes],
  );

  const flowEdges = useMemo<Edge[]>(
    () =>
      edges.map((e, i) => ({
        id: `${e.source}->${e.target}-${i}`,
        source: e.source,
        target: e.target,
        ...(e.label ? { label: e.label } : {}),
        style: { stroke: "rgba(255,255,255,0.4)" },
      })),
    [edges],
  );

  if (nodes.length === 0) {
    return (
      <section data-panel="graph" className="rounded-lg border border-line bg-muted/40 p-4">
        <h3 className="mb-2 text-sm font-semibold text-white">Graph</h3>
        <p className="text-sm text-white/50">No nodes to display.</p>
      </section>
    );
  }

  return (
    <section
      data-panel="graph"
      className="overflow-hidden rounded-lg border border-line bg-muted/40"
      style={{ height: 320 }}
    >
      <ReactFlow
        nodes={flowNodes}
        edges={flowEdges}
        nodesDraggable={false}
        nodesConnectable={false}
        elementsSelectable={false}
        fitView
        proOptions={{ hideAttribution: true }}
      >
        <Background color="#2a2c33" gap={16} />
        <Controls showInteractive={false} className="!bg-muted/80" />
      </ReactFlow>
    </section>
  );
}

/** Lay nodes out in a circle around the centre — good enough for MVP. */
function layoutPosition(index: number, total: number): { x: number; y: number } {
  const radius = Math.min(140, 40 + total * 8);
  const angle = (index / Math.max(1, total)) * Math.PI * 2;
  return {
    x: 200 + Math.cos(angle) * radius,
    y: 140 + Math.sin(angle) * radius,
  };
}
