/**
 * Jeu de données 100 % SYNTHÉTIQUE pour l'environnement de test : aucun nom, montant ou
 * identifiant ne provient d'un client réel. Les dates sont relatives à « aujourd'hui » pour que
 * les scénarios restent dans l'horizon de projection quel que soit le jour où ils sont rejoués.
 *
 * Deux moitiés cohérentes entre elles :
 *  - chargesFixesSynthetiques : les Charges fixes de la société QANNT TEST (npm run staging:seed) ;
 *  - facturesFournisseursMock / facturesClientsMock : ce que renvoie le serveur mock Pennylane
 *    (npm run staging:mock), selon le cycle de synchronisation en cours.
 *
 * Cycles :
 *  1. état initial : factures ouvertes, sans échéance, anciennes, ambiguës, hors seuil ;
 *  2. la facture Crocatus du mois devient payée ;
 *  3. mois suivant : nouvelle facture Crocatus (fournisseur désormais connu), une facture d'un autre
 *     fournisseur au même montant, et la facture Assurix archivée puis remplacée par une nouvelle version.
 */
import { randomUUID } from "node:crypto";
import type { PennylaneCustomerInvoiceListItem, PennylaneSupplierInvoiceListItem } from "../../lib/pennylaneClient";
import type { Jeu } from "./exportReel";

function iso(annee: number, moisIndex: number, jour: number): string {
  const date = new Date(annee, moisIndex, jour);
  const mm = String(date.getMonth() + 1).padStart(2, "0");
  const jj = String(date.getDate()).padStart(2, "0");
  return `${date.getFullYear()}-${mm}-${jj}`;
}

/** Jour `jour` du mois courant décalé de `decalageMois` mois. */
export function dateRelative(aujourdhui: Date, decalageMois: number, jour: number): string {
  return iso(aujourdhui.getFullYear(), aujourdhui.getMonth() + decalageMois, jour);
}

export interface ChargeFixeSynthetique {
  cle: string; // référence interne au jeu de données (source d'une charge calculée)
  libelle: string;
  montant: number;
  jour: number;
  calcule?: { taux: number; sourceCle: string };
}

export const chargesFixesSynthetiques: ChargeFixeSynthetique[] = [
  { cle: "daf", libelle: "DAF part-time", montant: 2000, jour: 5 },
  { cle: "commission", libelle: "Commission sur DAF", montant: 200, jour: 25, calcule: { taux: 10, sourceCle: "daf" } },
  { cle: "loyer-bureau", libelle: "Loyer bureau", montant: 1500, jour: 10 },
  { cle: "loyer-entrepot", libelle: "Loyer entrepôt", montant: 1500, jour: 12 },
  { cle: "comptable", libelle: "Expert-comptable", montant: 600, jour: 15 },
  { cle: "assurance", libelle: "Assurance", montant: 800, jour: 20 },
];

export const SOLDE_INITIAL_SYNTHETIQUE = 50000;

/**
 * Données de la société staging en mode SYNTHÉTIQUE (npm run staging:seed -- --synthetique) :
 * entièrement fabriquées, sans aucun lien avec un export réel.
 */
export function jeuSynthetique(aujourdhui: Date, nouvelUuid: () => string = randomUUID): Jeu {
  const ids = new Map(chargesFixesSynthetiques.map((c) => [c.cle, nouvelUuid()]));
  return {
    cash_settings: { solde_initial: SOLDE_INITIAL_SYNTHETIQUE, date_releve: dateRelative(aujourdhui, 0, aujourdhui.getDate()), horizon_jours: 90 },
    fixed_charges: chargesFixesSynthetiques.map((c) => ({
      id: ids.get(c.cle),
      libelle: c.libelle,
      montant: c.montant,
      date_prevue: dateRelative(aujourdhui, 0, c.jour),
      recurrence: "mensuel",
      date_fin: null,
      mode_montant: c.calcule ? "calcule" : "fixe",
      taux_calcul: c.calcule ? c.calcule.taux : null,
      source_calcul_id: c.calcule ? ids.get(c.calcule.sourceCle) : null,
      source_calcul_type: c.calcule ? "charge_fixe" : null,
      a_couper: false,
    })),
    recurring_income: [],
    supplier_invoices: [],
    customer_invoices: [],
    other_expenses: [],
    financings: [],
  };
}

interface FactureMock {
  id: number;
  fournisseurId: number;
  fournisseur: string;
  numero: string;
  montant: number;
  date: string | null;
  echeance: string | null;
  payee?: boolean;
  archivee?: boolean;
}

function versItemFournisseur(f: FactureMock): PennylaneSupplierInvoiceListItem {
  return {
    id: f.id,
    invoice_number: f.numero,
    date: f.date,
    label: `Facture ${f.fournisseur} - ${f.numero} (label généré)`,
    amount: f.montant.toFixed(2),
    deadline: f.echeance,
    paid: Boolean(f.payee),
    payment_status: f.payee ? "fully_paid" : "to_be_paid",
    accounting_status: f.archivee ? "archived" : "complete",
    archived_at: f.archivee ? "2026-01-01T00:00:00Z" : null,
    remaining_amount_with_tax: f.payee ? "0.0" : (-f.montant).toFixed(2),
    supplier: { id: f.fournisseurId },
  };
}

export const NOMBRE_FACTURES_REMPLISSAGE = 230; // > 2 pages de 100 : exerce la pagination

export function facturesFournisseursMock(cycle: number, aujourdhui: Date): PennylaneSupplierInvoiceListItem[] {
  const m = (jour: number) => dateRelative(aujourdhui, 0, jour);
  const m1 = (jour: number) => dateRelative(aujourdhui, 1, jour);

  const factures: FactureMock[] = [
    // Rapprochement attendu avec « DAF part-time » (2 000 € prévus) : montant proche, même mois.
    { id: 1001, fournisseurId: 501, fournisseur: "CROCATUS", numero: "CRO-0001", montant: 1990, date: m(1), echeance: m(28), payee: cycle >= 2 },
    // Deux Charges fixes à 1 500 € le même mois : ambiguïté.
    { id: 1002, fournisseurId: 502, fournisseur: "IMMO GESTION", numero: "IG-0420", montant: 1500, date: m(2), echeance: m(11) },
    // Fournisseur inconnu, montant proche de « Expert-comptable » (600 €) : proposition à refuser.
    { id: 1003, fournisseurId: 503, fournisseur: "FIDUCIA", numero: "FID-77", montant: 590, date: m(3), echeance: m(16) },
    // Hors seuil par rapport à « Assurance » (800 €) : jamais proposée, rapprochement manuel seulement.
    { id: 1004, fournisseurId: 504, fournisseur: "ASSURIX", numero: "AX-2026-10", montant: 1100, date: m(4), echeance: m(21), archivee: cycle >= 3 },
    // Ni date ni échéance.
    { id: 1005, fournisseurId: 505, fournisseur: "SANS ECHEANCE SARL", numero: "SE-1", montant: 320, date: null, echeance: null },
    // Ancienne facture réellement impayée : doit remonter.
    { id: 1006, fournisseurId: 506, fournisseur: "VIEUX FOURNISSEUR", numero: "VF-2023-03", montant: 450, date: "2023-03-10", echeance: "2023-04-10" },
    // Ancienne facture payée : jamais importée.
    { id: 1007, fournisseurId: 506, fournisseur: "VIEUX FOURNISSEUR", numero: "VF-2023-01", montant: 380, date: "2023-01-10", echeance: "2023-02-10", payee: true },
  ];

  if (cycle >= 3) {
    factures.push(
      // Mois suivant, même fournisseur que le rapprochement déjà confirmé : proposition forte.
      { id: 1010, fournisseurId: 501, fournisseur: "CROCATUS", numero: "CRO-0002", montant: 1995, date: m1(1), echeance: m1(28) },
      // Même montant que « DAF part-time » mais autre fournisseur : jamais prioritaire.
      { id: 1008, fournisseurId: 507, fournisseur: "AUTRE CONSEIL", numero: "AC-9", montant: 2000, date: m1(2), echeance: m1(6) },
      // Nouvelle version de la facture Assurix archivée.
      { id: 1011, fournisseurId: 504, fournisseur: "ASSURIX", numero: "AX-2026-10-B", montant: 1100, date: m(4), echeance: m(22) }
    );
  }

  // Volume : factures anciennes déjà payées, uniquement pour dépasser une page de résultats.
  for (let i = 0; i < NOMBRE_FACTURES_REMPLISSAGE; i++) {
    factures.push({
      id: 2001 + i,
      fournisseurId: 600 + (i % 20),
      fournisseur: `FOURNISSEUR ${String((i % 20) + 1).padStart(2, "0")}`,
      numero: `REMP-${String(i + 1).padStart(4, "0")}`,
      montant: 100 + i,
      date: "2024-06-01",
      echeance: "2024-07-01",
      payee: true,
    });
  }

  return factures.map(versItemFournisseur);
}

export function facturesClientsMock(cycle: number, aujourdhui: Date): PennylaneCustomerInvoiceListItem[] {
  const m = (jour: number) => dateRelative(aujourdhui, 0, jour);
  const base = [
    { id: 3001, client: "CLIENT ALPHA", numero: "FA-0001", montant: 8400, echeance: m(18), payee: false },
    { id: 3002, client: "CLIENT BETA", numero: "FA-0002", montant: 3600, echeance: m(27), payee: cycle >= 2 },
    { id: 3003, client: "CLIENT GAMMA", numero: "FA-0003", montant: 5200, echeance: dateRelative(aujourdhui, 1, 8), payee: false },
  ];
  return base.map((f) => ({
    id: f.id,
    invoice_number: f.numero,
    date: m(1),
    label: `Facture ${f.client} - ${f.numero} (label généré)`,
    amount: f.montant.toFixed(2),
    deadline: f.echeance,
    paid: f.payee,
    draft: false,
    status: f.payee ? "paid" : "upcoming",
    archived_at: null,
  }));
}
