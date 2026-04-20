"use client";

import { useEffect, useRef } from "react";
import type { LatLngTuple } from "leaflet";
import L from "leaflet";
import { MapContainer, Marker, Polyline, Popup, TileLayer, useMap } from "react-leaflet";
import "leaflet/dist/leaflet.css";

/**
 * Real slippy map for the route_map panel. CartoDB Dark Matter tiles
 * keep the palette on-brand (dark grey continents, dimmed labels)
 * without forcing us into a paid Mapbox account. OSM attribution is
 * required by CARTO's TOS — the `attribution` prop on TileLayer
 * renders it in the bottom-right corner.
 *
 * Leaflet writes to `window` on import, so this component is loaded
 * via dynamic(ssr:false) from the outer RouteMapPanel.
 */

interface Point {
  label: string;
  lat: number;
  lon: number;
}

interface Props {
  origin: Point;
  destination: Point;
  /** When true, the map fills the viewport (expanded modal mode). */
  expanded?: boolean;
}

// Built-in Leaflet marker icons reference PNGs under /images which
// don't exist in a Next bundle. Ship a pair of tiny inline SVG
// divIcons keyed by tone so the pins match the Vex palette.
function makeDotIcon(accent: "purple" | "amber", label: string): L.DivIcon {
  const fill = accent === "purple" ? "#7c5cff" : "#f59e0b";
  const glow = accent === "purple" ? "rgba(124,92,255,0.35)" : "rgba(245,158,11,0.35)";
  return L.divIcon({
    className: "vex-route-pin",
    html: `
      <div style="position:relative;display:flex;flex-direction:column;align-items:center;">
        <span style="
          position:absolute;bottom:100%;margin-bottom:4px;
          padding:2px 6px;border-radius:4px;
          background:rgba(15,15,20,0.85);color:#fff;
          font-size:11px;font-family:ui-monospace,monospace;
          white-space:nowrap;border:1px solid rgba(255,255,255,0.15);
          pointer-events:none;
        ">${label.replace(/</g, "&lt;")}</span>
        <span style="
          width:14px;height:14px;border-radius:50%;
          background:${fill};box-shadow:0 0 0 6px ${glow};
          border:2px solid rgba(15,15,20,0.9);
        "></span>
      </div>`,
    iconSize: [14, 14],
    iconAnchor: [7, 7],
  });
}

function FitBounds({ origin, destination }: { origin: Point; destination: Point }) {
  const map = useMap();
  useEffect(() => {
    const bounds = L.latLngBounds([
      [origin.lat, origin.lon],
      [destination.lat, destination.lon],
    ]);
    map.fitBounds(bounds, { padding: [48, 48], maxZoom: 6 });
  }, [map, origin.lat, origin.lon, destination.lat, destination.lon]);
  return null;
}

export default function RouteMapLeaflet({ origin, destination, expanded }: Props) {
  const originIcon = useRef(makeDotIcon("purple", origin.label));
  const destIcon = useRef(makeDotIcon("amber", destination.label));

  const points: LatLngTuple[] = [
    [origin.lat, origin.lon],
    [destination.lat, destination.lon],
  ];

  return (
    <MapContainer
      center={[
        (origin.lat + destination.lat) / 2,
        (origin.lon + destination.lon) / 2,
      ]}
      zoom={4}
      scrollWheelZoom={expanded === true}
      zoomControl={expanded === true}
      attributionControl
      style={{
        height: "100%",
        width: "100%",
        background: "#0b0b0e",
      }}
    >
      <TileLayer
        url="https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png"
        subdomains={["a", "b", "c", "d"]}
        maxZoom={19}
        attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> &copy; <a href="https://carto.com/attributions">CARTO</a>'
      />
      <Polyline
        positions={points}
        pathOptions={{
          color: "#7c5cff",
          weight: 2.5,
          opacity: 0.85,
          dashArray: "6 8",
        }}
      />
      <Marker position={[origin.lat, origin.lon]} icon={originIcon.current}>
        <Popup>
          <strong>{origin.label}</strong>
          <br />
          <span style={{ fontFamily: "ui-monospace,monospace" }}>
            {origin.lat.toFixed(3)}, {origin.lon.toFixed(3)}
          </span>
        </Popup>
      </Marker>
      <Marker position={[destination.lat, destination.lon]} icon={destIcon.current}>
        <Popup>
          <strong>{destination.label}</strong>
          <br />
          <span style={{ fontFamily: "ui-monospace,monospace" }}>
            {destination.lat.toFixed(3)}, {destination.lon.toFixed(3)}
          </span>
        </Popup>
      </Marker>
      <FitBounds origin={origin} destination={destination} />
    </MapContainer>
  );
}
