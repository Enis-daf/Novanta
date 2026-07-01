import type { Metadata } from "next";
import { Lexend } from "next/font/google";
import "./globals.css";

const lexend = Lexend({ subsets: ["latin"], variable: "--font-lexend" });

export const metadata: Metadata = {
  title: "Cockpit tactique de trésorerie — J+90",
  description: "Pilotage tactique de la trésorerie à 90 jours",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="fr" className={lexend.variable}>
      <body>{children}</body>
    </html>
  );
}
