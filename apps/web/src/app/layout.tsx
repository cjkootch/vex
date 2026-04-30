import type { Metadata } from "next";
import type { ReactNode } from "react";
import { Inter, JetBrains_Mono, Montserrat } from "next/font/google";
import "./globals.css";

/**
 * Typography. Montserrat is the canonical UI font, shared with procur
 * (see docs/shell-unification spec) — same shell visual register
 * across both apps. Inter stays as a fallback variable so any leftover
 * usage doesn't FOUC; JetBrains Mono powers structured values
 * (deal refs, UN/LOCODEs, timestamps, port coords). All self-hosted
 * via next/font so there's no runtime flash.
 */
const montserrat = Montserrat({
  subsets: ["latin"],
  variable: "--font-montserrat",
  display: "swap",
  weight: ["400", "500", "600", "700"],
});
const sans = Inter({
  subsets: ["latin"],
  variable: "--font-sans",
  display: "swap",
  weight: ["400", "500", "600", "700"],
});
const mono = JetBrains_Mono({
  subsets: ["latin"],
  variable: "--font-mono",
  display: "swap",
  weight: ["400", "500", "600"],
});

export const metadata: Metadata = {
  title: "Vex",
  description: "AI-native revenue intelligence — https://vexhq.ai",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html
      lang="en"
      className={`${montserrat.variable} ${sans.variable} ${mono.variable}`}
    >
      <body className="min-h-screen bg-canvas font-sans text-white antialiased">
        {children}
      </body>
    </html>
  );
}
