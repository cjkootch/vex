import type { Metadata } from "next";
import type { ReactNode } from "react";
import { Inter, JetBrains_Mono } from "next/font/google";
import "./globals.css";

/**
 * Typography. Inter for all UI; JetBrains Mono for structured values
 * (deal refs, UN/LOCODEs, timestamps, port coords). Both self-hosted
 * via next/font so there's no runtime flash and no third-party
 * request on every page. Variable weights keep the bundle small.
 */
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
    <html lang="en" className={`${sans.variable} ${mono.variable}`}>
      <body className="min-h-screen bg-canvas font-sans text-white antialiased">
        {children}
      </body>
    </html>
  );
}
