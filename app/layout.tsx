import type { Metadata } from "next";
import { Lexend } from "next/font/google";
import "./globals.css";
import { AnalyseSessionProvider } from "@/components/AnalyseSessionContext";
import { estModeStaging } from "@/lib/environnementGuard";
import { modePennylane } from "@/lib/pennylaneClient";

const lexend = Lexend({ subsets: ["latin"], variable: "--font-lexend" });

export const metadata: Metadata = {
  title: "Novanta - cockpit de tréso",
  description: "Pilotage tactique de la trésorerie à 90 jours",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="fr" className={lexend.variable}>
      <body>
        {/* Environnement de test isolé uniquement (voir lib/environnementGuard.ts) : jamais
            rendu en Production, où NEXT_PUBLIC_NOVANTA_ENV n'existe pas. */}
        {estModeStaging() && (
          <div className="bandeau-staging">
            QANNT TEST — STAGING · {modePennylane() === "mock" ? "Pennylane mock" : "Pennylane réel"}
          </div>
        )}
        {/* Seul point réellement commun à "/" et "/account/*" : voir AnalyseSessionContext.tsx
            pour pourquoi l'état des analyses doit vivre ici et pas plus bas. */}
        <AnalyseSessionProvider>{children}</AnalyseSessionProvider>
      </body>
    </html>
  );
}
