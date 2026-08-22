import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "CineForge — автономная AI-киностудия",
  description: "Сценарий, согласованность, генерация, монтаж и экспорт в едином восстанавливаемом процессе создания фильма.",
  icons: { icon: "/cineforge-icon.png", apple: "/cineforge-icon.png" },
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="ru">
      <body>{children}</body>
    </html>
  );
}
