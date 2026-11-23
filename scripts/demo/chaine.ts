import { calculerProjectionCash, listerFluxProjetes, ParametresProjectionCash, SourceFlux } from "../../lib/cash-engine";
import { construireHistorique, FacturePayeeFutur } from "../../lib/probaHistorique";
import { calibrerModele, ModeleRetards } from "../../lib/probaCalibration";
import { cleLigne, construireEvenements, HypotheseLigne } from "../../lib/probaEvenements";
import { CleGroupeHypotheses, completude, construireLignesHypotheses } from "../../lib/probaEcran";
import { analyserRisques, FactureAnalysee, PerimetreFactures } from "../../lib/probaRisques";
import { creerEvaluateur, preparerSimulation, simuler } from "../../lib/probaSimulation";
import { calculerIndicateurs } from "../../lib/probaIndicateurs";
import { estimerDates, facturesEnRetard, LIBELLES_RAISON_A_ACTUALISER } from "../../lib/probaEstimation";
import { estPrevisionnelleActive } from "../../lib/facturesPrevisionnelles";
import { classerDepense, CORRESPONDANCE_VIDE, groupeDeClassement } from "../../lib/futurPnl";
import type { EtagePnl } from "../../lib/pastCategoryMapping";
import type { FactureBfr } from "../../lib/pastBfr";

/**
 * La chaîne de Perspectives pondérées, exécutée hors navigateur avec les MÊMES fonctions que
 * l'écran et les routes (components/PrevisionProbabiliste.tsx, app/api/futur/probabiliste/*) :
 * historique -> calibration -> estimations des factures en retard -> flux -> hypothèses ->
 * Gestion des risques -> Monte Carlo. Sert à vérifier un jeu de données sur ses vraies valeurs.
 */
export type DonneesFutur = Omit<ParametresProjectionCash, "dateDepart" | "horizonJours" | "datesEstimees"> & {
  dateReleve: string;
  horizonJours: number;
};

export function executerChaine(d: DonneesFutur, hypotheses: HypotheseLigne[], historiquePennylane: FactureBfr[] = [], graine = 20_20) {
  const dateDepart = d.dateReleve;
  // 1. Historique et calibration (lib/probaServeur.ts::calibrerCompte, sans écriture du profil).
  const payees: FacturePayeeFutur[] = d.facturesClients
    .filter((f) => f.payee && f.settledOn)
    .map((f) => ({ tiers: f.client, montant: f.montant, dateEcheance: f.dateEcheance || null, settledOn: f.settledOn ?? null, pennylaneId: f.pennylaneId ?? null }));
  const historique = construireHistorique(historiquePennylane, { clients: payees, fournisseurs: [] }, dateDepart);
  const modeles: { client: ModeleRetards; fournisseur: ModeleRetards } = {
    client: calibrerModele(historique.client, "client", dateDepart),
    fournisseur: calibrerModele(historique.fournisseur, "fournisseur", dateDepart),
  };
  // 2. Factures en retard : dates estimées (route /estimations).
  const enRetard = facturesEnRetard(d.facturesClients, dateDepart);
  const estimations = estimerDates(enRetard, modeles.client, dateDepart);
  const datesEstimees = new Map(estimations.flatMap((e) => (e.statut === "estimee" ? [[e.factureId, e.date] as [string, string]] : [])));
  const projection: Omit<ParametresProjectionCash, "soldeInitial"> = { ...d, dateDepart, horizonJours: d.horizonJours, datesEstimees };
  // 3. Flux, lignes de l'écran, événements du moteur.
  const flux = listerFluxProjetes(projection);
  const parCle = new Map(hypotheses.map((h) => [cleLigne(h.source, h.sourceId), h]));
  const depenses = new Map<string, Parameters<typeof classerDepense>[0]>();
  for (const f of d.facturesFournisseurs) depenses.set(cleLigne("facture_fournisseur", f.id), f);
  for (const c of d.chargesFixes) depenses.set(cleLigne("charge_fixe", c.id), c);
  for (const a of d.autresDepenses) depenses.set(cleLigne("autre_depense", a.id), a);
  const groupeDe = (s: SourceFlux, id: string): CleGroupeHypotheses => {
    if (s === "facture_client" || s === "facture_previsionnelle" || s === "rentree_reguliere") return "revenue";
    if (s === "financement") return "financing";
    const dep = depenses.get(cleLigne(s, id));
    return (dep && groupeDeClassement(classerDepense(dep, CORRESPONDANCE_VIDE))) ?? "a_classer";
  };
  const etageDe = (s: SourceFlux, id: string): EtagePnl | null => {
    if (s === "facture_client" || s === "facture_previsionnelle" || s === "rentree_reguliere") return "revenue";
    if (s === "financement") return "financing";
    const dep = depenses.get(cleLigne(s, id));
    return dep ? classerDepense(dep, CORRESPONDANCE_VIDE).etage : null;
  };
  const rentreesFixes = new Set(d.rentreesRegulieres.filter((r) => r.modeMontant === "fixe").map((r) => cleLigne("rentree_reguliere", r.id)));
  const lignesEcran = construireLignesHypotheses(flux, parCle, groupeDe, { rentreesFixes, echeanceDe: (s, id) => (s === "facture_client" ? d.facturesClients.find((f) => f.id === id)?.dateEcheance || null : null) });
  const etat = completude(lignesEcran);
  const { lignes, evenements } = construireEvenements(flux, projection, hypotheses, etageDe);
  // 4. Gestion des risques (route /risques).
  const factures: FactureAnalysee[] = [
    ...d.facturesClients.filter((f) => !f.payee && !f.litigieuse).map((f) => ({ cleLigne: cleLigne("facture_client", f.id), type: "facture_client" as const, numero: f.facture || null, client: f.client, dateEcheance: f.dateEcheance || null })),
    ...(d.facturesPrevisionnelles ?? []).filter(estPrevisionnelleActive).map((p) => ({ cleLigne: cleLigne("facture_previsionnelle", p.id), type: "facture_previsionnelle" as const, numero: null, client: p.client, dateEcheance: null })),
  ];
  const parId = new Map(enRetard.map((f) => [f.id, f]));
  const perimetre: PerimetreFactures = {
    enRetardEstimees: datesEstimees.size,
    aActualiser: estimations.flatMap((e) =>
      e.statut === "a_actualiser" ? [{ cleLigne: cleLigne("facture_client", e.factureId), numero: parId.get(e.factureId)?.numero ?? null, client: parId.get(e.factureId)?.client ?? "", montant: parId.get(e.factureId)?.montant ?? 0, raison: LIBELLES_RAISON_A_ACTUALISER[e.raison] }] : []
    ),
    litigieusesExclues: d.facturesClients.filter((f) => !f.payee && f.litigieuse).length,
    horsHorizon: 0,
  };
  const parametresMoteur = { soldeInitial: d.soldeInitial, dateDepart, horizonJours: d.horizonJours, lignes, evenements, modeles };
  const risques = analyserRisques({ ...parametresMoteur, factures, perimetre }, modeles.client);
  // 5. Monte Carlo (route /probabiliste), seulement si aucune hypothèse importante n'est à renseigner.
  const monteCarlo = etat.bloquee ? null : calculerIndicateurs(simuler({ ...parametresMoteur, graine, nombreSimulations: 10_000 }));
  const reference = calculerProjectionCash({ soldeInitial: d.soldeInitial, ...projection });
  // Évaluateur déterministe pour rejouer un stress précis (index d'événement par clé de ligne).
  const prep = preparerSimulation(parametresMoteur);
  const evaluer = creerEvaluateur(prep);
  const indexDe = (cle: string) => prep.sources.findIndex((e) => e.cleLigne === cle);
  return { modeles, estimations, flux, lignesEcran, etat, risques, monteCarlo, reference, evaluer, indexDe, dates: prep.dates };
}
