import { createHash } from "node:crypto";
import { decalerDateISO } from "../../lib/dates";
import type { AutreDepense, ChargeFixe, FactureClient, FactureFournisseur, Financement, RentreeReguliere } from "../../lib/types";
import type { FacturePrevisionnelle } from "../../lib/facturesPrevisionnelles";
import type { HypotheseLigne } from "../../lib/probaEvenements";

/**
 * Jeu de démonstration « Perspectives pondérées » (offre Pilotage). Données FICTIVES, toutes
 * repérées par le préfixe DEMO-PILOTAGE (numéro de facture ou libellé) et par des identifiants
 * DÉTERMINISTES (dérivés de la société et d'une clé stable) : réécrire le jeu met à jour les mêmes
 * lignes, sans doublon ; le retirer ne touche qu'elles.
 *
 * Toutes les dates sont relatives à J0 (date du relevé, cash_settings.date_releve) : réancrer le
 * jeu = le réécrire avec un autre J0.
 *
 * Noyau des 30 premiers jours (dates de la projection de référence) :
 *   J0 solde 35 000 € · A +20 000 € J1 · B +15 000 € J10 · paie −45 000 € J11 ·
 *   échéances sociales et fiscales −15 000 € J15 · D +50 000 € J20 (reste dû d'une facture de
 *   80 000 €) · fournisseurs −35 000 € J25.
 * Après J30 : rentrée régulière, dépenses fixes, recrutement conditionnel, financement potentiel,
 * équipement, acompte d'un projet non signé (facture prévisionnelle).
 * Historique : factures réglées de quatre profils de clients, pour la calibration des retards.
 */

export const PREFIXE = "DEMO-PILOTAGE";

export const CLIENTS = {
  aurore: "DEMO — Atelier Aurore", // ponctuel
  boreal: "DEMO — Studio Boréal", // irrégulier
  rivage: "DEMO — Groupe Rivage", // régulièrement tardif
  nova: "DEMO — Nova Horizon", // nouveau client, sans historique propre
} as const;

/** UUID déterministe (forme v5) : même société, même clé -> même identifiant. */
export function uuidDemo(companyId: string, cle: string): string {
  const h = createHash("sha1").update(`${companyId}|${PREFIXE}|${cle}`).digest("hex");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-5${h.slice(13, 16)}-${((parseInt(h.slice(16, 18), 16) & 0x3f) | 0x80).toString(16)}${h.slice(18, 20)}-${h.slice(20, 32)}`;
}

export interface OptionsJeu {
  // Étape « agir avant la tension » : financement confirmé de 30 000 € à J8.
  financementAnticipation?: boolean;
  // Vérification temporaire : date d'encaissement anticipée de A passée, ou absente.
  factureAEnRetard?: "date_passee" | "sans_date";
  // Les trois hypothèses pédagogiques déjà renseignées (état « après démonstration »).
  hypothesesRenseignees?: boolean;
}

export interface JeuDemo {
  j0: string;
  soldeInitial: number;
  horizonJours: 90;
  facturesClients: (FactureClient & { settledOn?: string | null })[];
  facturesFournisseurs: FactureFournisseur[];
  chargesFixes: ChargeFixe[];
  autresDepenses: AutreDepense[];
  financements: Financement[];
  rentreesRegulieres: RentreeReguliere[];
  facturesPrevisionnelles: FacturePrevisionnelle[];
  hypotheses: HypotheseLigne[];
}

// Seuil du recrutement conditionnel : CA du mois précédent son démarrage (moteur : encaissements
// clients classés en CA, à leur date de référence). Référence de décembre : D 50 000 € + rentrée
// 18 000 € = 68 000 € > 60 000 € -> activé ; si D glisse en janvier, 18 000 € -> non activé.
export const SEUIL_RECRUTEMENT = 60_000;

export function jeuPilotage(companyId: string, j0: string, options: OptionsJeu = {}): JeuDemo {
  const j = (n: number) => decalerDateISO(j0, n);
  const id = (cle: string) => uuidDemo(companyId, cle);
  const facture = (cle: string, client: string, montant: number, echeance: string, anticipee: string, extra: Partial<FactureClient> = {}): FactureClient => ({
    id: id(cle),
    facture: `${PREFIXE}-${cle}`,
    client,
    montant,
    dateEcheance: echeance,
    dateEncaissementAnticipee: anticipee,
    litigieuse: false,
    payee: false,
    paidAt: null,
    settledOn: null,
    pennylaneId: null,
    ...extra,
  });

  // --- Noyau ---
  const dateA = options.factureAEnRetard === "date_passee" ? j(-3) : options.factureAEnRetard === "sans_date" ? "" : j(1);
  const facturesClients: JeuDemo["facturesClients"] = [
    // A : échéance contractuelle déjà passée (J−12), encaissement actualisé à J1.
    facture("A", CLIENTS.aurore, 20_000, j(-12), dateA),
    facture("B", CLIENTS.boreal, 15_000, j(10), j(10)),
    // D : facture de 80 000 € dont 30 000 € réglés avant J0 (déjà dans le solde) : reste dû 50 000 €.
    facture("D", CLIENTS.rivage, 50_000, j(20), j(20)),
  ];

  // --- Historique réglé (calibration) : 12 factures par profil, réglées avant J0 ---
  const profils: [keyof typeof CLIENTS, number[]][] = [
    ["aurore", [0, 0, 1, 2, 0, 3, 1, 0, 4, 2, 0, 1]],
    ["boreal", [3, 12, 25, 6, 18, 2, 30, 9, 14, 21, 5, 27]],
    ["rivage", [28, 45, 60, 35, 52, 40, 31, 58, 47, 38, 55, 42]],
  ];
  for (const [profil, retards] of profils) {
    retards.forEach((retard, i) => {
      const echeance = j(-300 + i * 22 + (profil === "boreal" ? 5 : profil === "rivage" ? 9 : 0));
      const reglement = decalerDateISO(echeance, retard);
      facturesClients.push(
        facture(`H-${profil}-${String(i + 1).padStart(2, "0")}`, CLIENTS[profil], 6_000 + i * 750, echeance, echeance, {
          payee: true,
          paidAt: `${reglement}T09:00:00.000Z`,
          settledOn: reglement,
        })
      );
    });
  }

  const facturesFournisseurs: FactureFournisseur[] = [
    {
      id: id("F-fournisseurs"),
      facture: `${PREFIXE}-F1`,
      fournisseur: "DEMO — Fournisseurs du mois",
      montant: 35_000,
      dateEcheance: j(25),
      datePaiementPrevue: j(25),
      litigieuse: false,
      payee: false,
      paidAt: null,
      pennylaneId: null,
    },
  ];

  const charge = (cle: string, libelle: string, montant: number, debut: string, recurrence: ChargeFixe["recurrence"]): ChargeFixe => ({
    id: id(cle),
    libelle: `${PREFIXE} — ${libelle}`,
    montant,
    datePrevue: debut,
    recurrence,
    dateFin: null,
    modeMontant: "fixe",
    tauxCalcul: null,
    sourceCalculId: null,
    sourceCalculType: null,
    aCouper: false,
  });
  const chargesFixes: ChargeFixe[] = [
    charge("C-paie", "Paie", 45_000, j(11), "ponctuel"),
    charge("C-sociales", "Échéances sociales et fiscales", 15_000, j(15), "ponctuel"),
    charge("C-equipe", "Équipe existante", 22_000, j(40), "mensuel"),
    charge("C-structure", "Frais de structure", 4_000, j(42), "mensuel"),
    charge("C-recrutement", "Recrutement conditionnel", 4_500, j(44), "mensuel"),
  ];

  const autresDepenses: AutreDepense[] = [
    { id: id("AD-equipement"), libelle: `${PREFIXE} — Équipement`, montant: 9_000, datePrevue: j(50), type: "probable", facturee: false, payee: false },
  ];

  const financements: Financement[] = [
    { id: id("FI-potentiel"), libelle: `${PREFIXE} — Financement potentiel`, montant: 12_000, dateEncaissementPrevue: j(47), verse: false },
  ];
  if (options.financementAnticipation) {
    financements.push({ id: id("FI-anticipation"), libelle: `${PREFIXE} — Financement confirmé (anticipation)`, montant: 30_000, dateEncaissementPrevue: j(8), verse: false });
  }

  const rentreesRegulieres: RentreeReguliere[] = [
    {
      id: id("R-contrats"),
      libelle: `${PREFIXE} — Contrats récurrents`,
      montant: 18_000,
      dateDebut: j(35),
      frequence: "mensuel",
      dateFin: null,
      modeMontant: "fixe",
      profilSaisonnalite: null,
    },
  ];

  const facturesPrevisionnelles: FacturePrevisionnelle[] = [
    {
      id: id("P-acompte"),
      client: `${CLIENTS.nova} (${PREFIXE} — acompte projet non signé)`,
      montant: 8_000,
      dateFacturationPrevue: j(55),
      dateEncaissementPrevue: j(60),
      rapprochement: null,
      facturesIgnorees: [],
    },
  ];

  // --- Hypothèses enregistrées ---
  const hypotheses: HypotheseLigne[] = [
    { source: "facture_client", sourceId: id("A"), probabilite: 100, fiabiliteDate: 75, fiabiliteMontant: null, montantCible: null, condition: null },
    { source: "facture_client", sourceId: id("B"), probabilite: 100, fiabiliteDate: 75, fiabiliteMontant: null, montantCible: null, condition: null },
    { source: "facture_client", sourceId: id("D"), probabilite: 100, fiabiliteDate: 50, fiabiliteMontant: null, montantCible: null, condition: null },
    {
      source: "charge_fixe",
      sourceId: id("C-recrutement"),
      probabilite: 100,
      fiabiliteDate: 50,
      fiabiliteMontant: null,
      montantCible: null,
      condition: { type: "seuil", indicateur: "ca_mois_precedent", comparateur: ">", valeur: SEUIL_RECRUTEMENT },
    },
    { source: "facture_previsionnelle", sourceId: id("P-acompte"), probabilite: 75, fiabiliteDate: 50, fiabiliteMontant: 100, montantCible: null, condition: null },
  ];
  if (options.hypothesesRenseignees) {
    // Les trois choix du guide (étape « Compléter les hypothèses »).
    hypotheses.push(
      { source: "rentree_reguliere", sourceId: id("R-contrats"), probabilite: 100, fiabiliteDate: 100, fiabiliteMontant: 50, montantCible: 18_000, condition: null },
      { source: "financement", sourceId: id("FI-potentiel"), probabilite: 25, fiabiliteDate: 50, fiabiliteMontant: 100, montantCible: null, condition: null },
      { source: "autre_depense", sourceId: id("AD-equipement"), probabilite: 50, fiabiliteDate: 75, fiabiliteMontant: 100, montantCible: null, condition: null }
    );
  }
  if (options.financementAnticipation) {
    hypotheses.push({ source: "financement", sourceId: id("FI-anticipation"), probabilite: 100, fiabiliteDate: 100, fiabiliteMontant: 100, montantCible: null, condition: null });
  }

  return { j0, soldeInitial: 35_000, horizonJours: 90, facturesClients, facturesFournisseurs, chargesFixes, autresDepenses, financements, rentreesRegulieres, facturesPrevisionnelles, hypotheses };
}
