import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "TrityReach | Lead Intelligence",
  description: "Turn website lists into structured, outreach-ready leads.",
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
