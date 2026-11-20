import { cleLigne } from "../../lib/probaEvenements";
import { executerChaine } from "./chaine";
import { uuidDemo } from "./jeuPilotage";

/** Résultats lisibles d'une exécution de la chaîne sur le jeu de démonstration. */
export function rapport(r: ReturnType<typeof executerChaine>, companyId: string) {
  const { dates } = r;
  const j = (iso: string) => dates.indexOf(iso);
  const solde = (jour: number) => r.reference.serie[jour]?.solde;
  const lignes: string[] = [];
  lignes.push(`Référence : J11 ${solde(11)} · J15 ${solde(15)} · J25 ${solde(25)} · point bas ${r.reference.pointBas} le ${r.reference.dateDuPointBas} (J${j(r.reference.dateDuPointBas)})`);
  const minimum = (s: Float64Array) => Math.min(...Array.from(s).slice(0, 31));
  const A = r.indexDe(cleLigne("facture_client", uuidDemo(companyId, "A")));
  const B = r.indexDe(cleLigne("facture_client", uuidDemo(companyId, "B")));
  const D = r.indexDe(cleLigne("facture_client", uuidDemo(companyId, "D")));
  const ref = r.evaluer().soldes;
  lignes.push(
    `Duo (A à J12, B à J12), minimum J0-J30 : référence ${minimum(ref)} · A seule ${minimum(r.evaluer(new Map([[A, 12]])).soldes)} · B seule ${minimum(r.evaluer(new Map([[B, 12]])).soldes)} · les deux ${minimum(r.evaluer(new Map([[A, 12], [B, 12]])).soldes)} (J11 ${r.evaluer(new Map([[A, 12], [B, 12]])).soldes[11]}, J12 ${r.evaluer(new Map([[A, 12], [B, 12]])).soldes[12]})`
  );
  const d28 = r.evaluer(new Map([[D, 28]])).soldes;
  lignes.push(`D à J28 : J24 ${d28[24]} · J25 ${d28[25]} · J27 ${d28[27]} · J28 ${d28[28]}`);
  lignes.push(`Hypothèses à renseigner : ${r.etat.aRenseigner} (importantes ${r.etat.importantesARenseigner}) · Monte Carlo ${r.etat.bloquee ? "bloqué" : "calculé"}`);
  lignes.push(`Calibration clients : ${r.modeles.client.confiance.nombreFactures} factures, confiance ${r.modeles.client.confiance.niveau} (${r.modeles.client.confiance.score})`);
  for (const e of r.estimations) lignes.push(`Estimation ${e.factureId.slice(0, 8)} : ${JSON.stringify(e)}`);
  const c = r.risques.couverture;
  lignes.push(`Couverture : ${c.facturesAnalysees} factures, méthode ${c.methode}, partielle ${c.partielle}, paires ${c.pairesExplorees}/${c.pairesPossibles}`);
  for (const g of r.risques.groupes) {
    for (const a of g.alertes) {
      lignes.push(
        `  [${g.type}] tension ${g.dateTension} (J${j(g.dateTension)}) déficit ${a.mesures.deficitMax} durée ${a.mesures.dureeJours} j · ` +
          a.factures.map((f) => `${f.numero} réf ${f.dateReference} testée ${f.dateTestee} (+${f.retardJours} j) reste ${f.montantRestant}`).join(" + ")
      );
    }
  }
  if (r.monteCarlo) {
    const mc = r.monteCarlo;
    const p = (d: number) => mc.serie[d];
    lignes.push(`Monte Carlo (${mc.nombreSimulations} simulations) : risque sous 0 avant la fin ${(mc.probaNegatifHorizon * 100).toFixed(1)} % · point bas P10/P50/P90 ${mc.minimum.p10}/${mc.minimum.p50}/${mc.minimum.p90}`);
    for (const d of [11, 15, 25, 45, 90]) if (p(d)) lignes.push(`  J${d} ${p(d).date} : P10 ${p(d).p10} · P50 ${p(d).p50} · P90 ${p(d).p90} · sous 0 ce jour ${(p(d).probaNegatif * 100).toFixed(1)} %`);
  }
  return lignes.join("\n");
}
