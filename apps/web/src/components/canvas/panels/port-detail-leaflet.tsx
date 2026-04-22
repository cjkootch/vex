"use client";

import { useRef } from "react";
import L from "leaflet";
import { MapContainer, Marker, Popup, TileLayer } from "react-leaflet";
import "leaflet/dist/leaflet.css";

/**
 * Single-port Leaflet map for the `port_detail` panel. Zooms in on
 * one port at regional scale (~zoom 7) with a labelled pin. Matches
 * the palette of RouteMapLeaflet so the two maps feel part of the
 * same system; the only difference is there's one point, not two,
 * and we default to a tighter zoom since there's no lane to fit.
 *
 * Leaflet writes to `window` on import, so load this via
 * dynamic(ssr:false) from the outer PortDetailPanel.
 */

interface Props {
  label: string;
  lat: number;
  lon: number;
  unlocode: string;
  expanded?: boolean;
}

function makePortIcon(label: string, unlocode: string): L.DivIcon {
  return L.divIcon({
    className: "vex-port-pin",
    html: `
      <div style="position:relative;display:flex;flex-direction:column;align-items:center;">
        <span style="
          position:absolute;bottom:100%;margin-bottom:4px;
          padding:2px 6px;border-radius:4px;
          background:rgba(15,15,20,0.85);color:#fff;
          font-size:11px;font-family:ui-monospace,monospace;
          white-space:nowrap;border:1px solid rgba(255,255,255,0.15);
          pointer-events:none;
        ">${label.replace(/</g, "&lt;")} · ${unlocode.replace(/</g, "&lt;")}</span>
        <span style="
          width:14px;height:14px;border-radius:50%;
          background:#7c5cff;box-shadow:0 0 0 6px rgba(124,92,255,0.35);
          border:2px solid rgba(15,15,20,0.9);
        "></span>
      </div>`,
    iconSize: [14, 14],
    iconAnchor: [7, 7],
  });
}

export default function PortDetailLeaflet({
  label,
  lat,
  lon,
  unlocode,
  expanded,
}: Props) {
  const icon = useRef(makePortIcon(label, unlocode));

  return (
    <MapContainer
      center={[lat, lon]}
      zoom={expanded ? 9 : 7}
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
      <Marker position={[lat, lon]} icon={icon.current}>
        <Popup>
          <strong>{label}</strong>
          <br />
          <span style={{ fontFamily: "ui-monospace,monospace" }}>
            {unlocode} · {lat.toFixed(3)}, {lon.toFixed(3)}
          </span>
        </Popup>
      </Marker>
    </MapContainer>
  );
}
