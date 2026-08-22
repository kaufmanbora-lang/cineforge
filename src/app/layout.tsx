import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "CineForge — Autonomous AI Movie Studio",
  description: "Screenwriting, continuity, generation, editing and export in one recoverable AI movie pipeline.",
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
