import type { Metadata } from "next";
import { Lexend } from "next/font/google";
import "./globals.css";
import { AnalyseSessionProvider } from "@/components/AnalyseSessionContext";

const lexend = Lexend({ subsets: ["latin"], variable: "--font-lexend" });

export const metadata: Metadata = {
  title: "Novanta - cockpit de tréso",
  description: "Pilotage tactique de la trésorerie à 90 jours",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="fr" className={lexend.variable}>
      <body>
        {/* Seul point réellement commun à "/" et "/account/*" : voir AnalyseSessionContext.tsx
            pour pourquoi l'état des analyses doit vivre ici et pas plus bas. */}
        <AnalyseSessionProvider>{children}</AnalyseSessionProvider>
      </body>
    </html>
  );
}
