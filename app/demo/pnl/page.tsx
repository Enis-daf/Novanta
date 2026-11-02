"use client";

import { notFound } from "next/navigation";
import { useMemo, useState } from "react";
import OffreVerrouillee from "@/components/OffreVerrouillee";
import PasseCompta from "@/components/PasseCompta";
import PassePnlCashEstime from "@/components/PassePnlCashEstime";
import PastDetailDashboard from "@/components/PastDetailDashboard";
import { AXE_DEMO, MAPPINGS_DEMO, servicesDemo, STOCKS_DEMO, TRANSACTIONS_DEMO } from "@/lib/comptaDemo";
import { teintesParCategorie } from "@/lib/dataviz";
import { ajustementsDeLaPeriode, ajustementsDepuisStocks } from "@/lib/pastAdjustments";
import { indexerMappings } from "@/lib/pastCategoryMapping";
import { partsMappees } from "@/lib/pastDetail";
import { partsEnBase, tauxParCategorie } from "@/lib/pastHtEstime";
import { pagesExportPdf } from "@/lib/pastPdfModel";
import { calculerPnlCashEstime, lignesAvertissementFlux } from "@/lib/pastPnlCashEstime";

// Démonstration sur données SIMULÉES : les vrais écrans et moteurs, sans base ni Pennylane. Répond 404
// sans NEXT_PUBLIC_NOVANTA_DEMO_PNL, qui n'est posée que sur un poste de développement.
const PERIODE = { debut: "2026-01-01", fin: "2026-03-31" };
const ECRANS = ["cash", "cash_flow", "compta", "compta_vide", "compta_conflit", "fec", "fec_api", "verrou"] as const;
type Ecran = (typeof ECRANS)[number];

const LIBELLES: Record<Ecran, string> = {
  cash: "P&L cash",
  cash_flow: "Cash flow",
  compta: "P&L comptable",
  compta_vide: "Sans correspondance",
  compta_conflit: "Conflit de stocks",
  fec: "Import FEC seul",
  fec_api: "FEC et API",
  verrou: "Offre Prévision",
};

export default function DemoPnlPage() {
  if (process.env.NEXT_PUBLIC_NOVANTA_DEMO_PNL !== "1") notFound();
  const [ecran, setEcran] = useState<Ecran>("cash");
  const [pdf, setPdf] = useState<string | null>(null);
  const mappings = useMemo(() => indexerMappings(MAPPINGS_DEMO), []);
  const ajustements = useMemo(() => ajustementsDeLaPeriode(ajustementsDepuisStocks(STOCKS_DEMO), PERIODE), []);
  const pnl = useMemo(() => calculerPnlCashEstime(TRANSACTIONS_DEMO, AXE_DEMO, mappings, ajustements), [mappings, ajustements]);
  const parts = useMemo(() => partsMappees(TRANSACTIONS_DEMO, AXE_DEMO, mappings), [mappings]);
  const teintes = useMemo(() => teintesParCategorie(pnl.categories), [pnl.categories]);
  // Contrôle du rendu réel : le rapport est dessiné par le même code que l'export du module.
  const genererPdf = async () => {
    const { genererPdfPasse } = await import("@/lib/pastPdfDocument");
    const pages = pagesExportPdf({
      pnl,
      parts: partsEnBase(parts, tauxParCategorie(mappings), "ht"),
      partsTtc: parts,
      base: "ht",
      presentation: "cash_estime",
      fluxHorsPnl: pnl.flux,
      periode: PERIODE,
      ajustements,
      avertissements: lignesAvertissementFlux(pnl.flux),
      ongletOuvert: "general",
      filtresOngletOuvert: { categorie: null, mois: null },
    });
    const blob = await genererPdfPasse({ organisation: "Démonstration", pages, teintes });
    setPdf(URL.createObjectURL(blob));
  };
  const services = useMemo(
    () => ({ compta: servicesDemo(), compta_vide: servicesDemo({ reglesInitiales: [] }), compta_conflit: servicesDemo({ avecStocksNovanta: true }), fec: servicesDemo({ sansApi: true }), fec_api: servicesDemo() }),
    []
  );
  return (
    <main className="cockpit">
      <section className="passe">
        <p className="passe-message">Démonstration : données simulées, aucune donnée réelle.</p>
        <div className="passe-tri selecteur" role="group" aria-label="Écran de démonstration">
          {ECRANS.map((e) => (
            <button key={e} type="button" className={`btn-secondaire${ecran === e ? " btn-module--actif" : ""}`} aria-pressed={ecran === e} onClick={() => setEcran(e)}>
              {LIBELLES[e]}
            </button>
          ))}
        </div>
        <button type="button" className="btn-secondaire" onClick={genererPdf}>
          Générer le rapport PDF
        </button>
        {pdf && (
          <a href={pdf} target="_blank" rel="noreferrer">
            Ouvrir le PDF
          </a>
        )}
        {ecran === "cash" && <PassePnlCashEstime pnl={pnl} cibles={null} teintes={teintes} onOuvrir={() => {}} onDefinirCible={() => {}} onConfigurer={() => {}} />}
        {ecran === "cash_flow" && (
          <PastDetailDashboard metrique="cash_flow" parts={parts} base="ttc" periode={PERIODE} ajustements={ajustements} teintes={teintes} fluxHorsPnl={pnl.flux} />
        )}
        {(ecran === "compta" || ecran === "compta_vide" || ecran === "compta_conflit" || ecran === "fec" || ecran === "fec_api") && <PasseCompta key={ecran} periode={PERIODE} services={services[ecran]} />}
        {ecran === "verrou" && <OffreVerrouillee capacite="canViewAccountingPnl" fonctionnalite="Le P&L comptable" offreActuelle="forecast" />}
      </section>
    </main>
  );
}
