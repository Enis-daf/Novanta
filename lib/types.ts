import type { CategorieFacture, EtageDepense } from "./futurPnl";

export interface FactureClient {
  id: string;
  facture: string;
  client: string;
  montant: number;
  dateEcheance: string; // YYYY-MM-DD
  dateEncaissementAnticipee: string; // YYYY-MM-DD — variable de simulation
  litigieuse: boolean;
  payee: boolean;
  paidAt: string | null; // ISO 8601 datetime — moment où "Payée" a été cochée
  // Règlement réel (YYYY-MM-DD) : date de la dernière transaction bancaire rapprochée chez
  // Pennylane. Écrit par le serveur seulement (/api/pennylane/invoices/settlement) ; sert au
  // masquage des factures payées (lib/dates.ts::estFactureMasquee), à rien d'autre.
  settledOn?: string | null;
  // ID de la facture côté Pennylane — présent uniquement si importée par la synchronisation
  // Pennylane (voir lib/pennylaneInvoiceAdapter.ts) ; absent/null pour une facture créée
  // manuellement ou importée par fichier. Clé de dédoublonnage, jamais recalculée.
  pennylaneId?: string | null;
}

export interface FactureFournisseur {
  id: string;
  facture: string;
  fournisseur: string;
  montant: number;
  dateEcheance: string; // YYYY-MM-DD
  datePaiementPrevue: string; // YYYY-MM-DD — variable de simulation
  litigieuse: boolean;
  payee: boolean;
  paidAt: string | null; // ISO 8601 datetime — moment où "Payée" a été cochée
  // Voir FactureClient.settledOn.
  settledOn?: string | null;
  // Voir FactureClient.pennylaneId — même rôle côté factures fournisseurs.
  pennylaneId?: string | null;
  // Étage P&L choisi dans Futur (null = aucun choix manuel) — voir lib/futurPnl.ts. Prime sur
  // l'étage issu des catégories Pennylane ; jamais écrit par une synchronisation.
  etagePnlManuel?: EtageDepense | null;
  // Catégories analytiques de la facture chez Pennylane (null = jamais lues). Écrites par le
  // serveur seulement (/api/pennylane/invoices/categories), jamais renvoyées par une sauvegarde.
  categoriesPennylane?: CategorieFacture[] | null;
  categoriesLuesLe?: string | null; // ISO 8601 datetime de la dernière lecture
  // ID du fournisseur côté Pennylane (supplier.id) : identité stable du tiers, utilisée en
  // priorité par le rapprochement avec les Charges fixes. Absent pour une facture manuelle.
  pennylaneSupplierId?: string | null;
}

/**
 * Décision de l'utilisateur sur un couple facture fournisseur <-> occurrence de Charge fixe
 * (table fixed_charge_invoice_links, voir lib/rapprochementChargesFixes.ts).
 *  - "confirme" : la facture remplace l'occurrence, qui ne génère plus de flux prévisionnel —
 *    indépendamment du statut Payée de la facture, et même si la facture est supprimée ensuite.
 *  - "refuse" : « Ce n'est pas la même dépense » — ce couple n'est plus reproposé.
 */
export interface LienRapprochement {
  id: string;
  chargeFixeId: string;
  factureFournisseurId: string | null; // null = la facture n'existe plus dans Novanta
  dateOccurrence: string; // YYYY-MM-DD
  statut: "confirme" | "refuse";
  // Copie de la facture au moment de la décision.
  factureLibelle: string | null;
  fournisseurLibelle: string | null;
  montantFacture: number | null;
  dateCashFacture: string | null;
  facturePennylaneId: string | null;
  fournisseurPennylaneId: string | null;
  revueEcarteeLe: string | null; // « Laisser remplacée » sur un lien dont la facture a disparu
}

/** Mémoire fournisseur <-> Charge fixe, écrite à chaque rapprochement confirmé. */
export interface MappingFournisseurCharge {
  id: string;
  chargeFixeId: string;
  pennylaneSupplierId: string | null;
  cleNom: string; // nom du fournisseur normalisé (repli quand il n'y a pas d'identifiant Pennylane)
  libelle: string;
}

export type ModeMontantChargeFixe = "fixe" | "calcule";

export type TypeSourceCalculChargeFixe = "charge_fixe" | "rentree_reguliere";

export interface ChargeFixe {
  id: string;
  libelle: string;
  montant: number; // montant fixe en mode "fixe" ; en mode "calcule", dernière valeur connue seulement — jamais lue par le moteur, voir lib/montantCalcule.ts
  datePrevue: string; // YYYY-MM-DD — première échéance
  recurrence: "ponctuel" | "quotidien" | "hebdomadaire" | "mensuel";
  dateFin: string | null; // YYYY-MM-DD — optionnelle, sinon jusqu'à J+90
  modeMontant: ModeMontantChargeFixe;
  tauxCalcul: number | null; // % — non nul uniquement en mode "calcule"
  sourceCalculId: string | null; // id de la ligne source (ChargeFixe non calculée ou RentreeReguliere)
  sourceCalculType: TypeSourceCalculChargeFixe | null;
  aCouper: boolean; // true = simulation d'exclusion ("À couper"), exclue du calcul sans supprimer la donnée
  // Étage P&L de la charge (null = « À classer ») — voir lib/futurPnl.ts. Porté par la charge
  // source : toutes ses occurrences le reprennent, sans copie par occurrence.
  etagePnlManuel?: EtageDepense | null;
}

export interface AutreDepense {
  id: string;
  libelle: string;
  montant: number;
  datePrevue: string; // YYYY-MM-DD
  type: "certaine" | "probable";
  facturee: boolean; // true = remplacée par une vraie facture fournisseur, exclue du calcul
  payee: boolean; // true = déjà comptée dans le solde bancaire initial, exclue du calcul (raison distincte de facturee)
  etagePnlManuel?: EtageDepense | null; // voir ChargeFixe.etagePnlManuel
}

export interface Financement {
  id: string;
  libelle: string;
  montant: number;
  dateEncaissementPrevue: string; // YYYY-MM-DD
  verse: boolean; // true = effectivement versé sur le compte, exclu du calcul (libellé UI : "Versé")
}

export type ModeMontantRentreeReguliere = "fixe" | "saisonnalise";

export interface ProfilSaisonnalite {
  montantAnnuel: number;
  ponderationsMensuelles: number[]; // 12 valeurs en %, index 0 = janvier ... 11 = décembre
}

export interface RentreeReguliere {
  id: string;
  libelle: string;
  montant: number; // montant fixe en mode "fixe" ; en mode "saisonnalise", dernière valeur connue seulement — jamais lue par le moteur, voir lib/saisonnalite.ts
  dateDebut: string; // YYYY-MM-DD
  frequence: "ponctuel" | "quotidien" | "hebdomadaire" | "mensuel";
  dateFin: string | null; // YYYY-MM-DD — optionnelle, sinon jusqu'à J+90
  modeMontant: ModeMontantRentreeReguliere;
  profilSaisonnalite: ProfilSaisonnalite | null; // non nul uniquement en mode "saisonnalise"
}

export interface SoldeJournalier {
  date: string; // YYYY-MM-DD
  solde: number;
}

export type HorizonJours = 90 | 180;

export type TriMode = "date" | "montant";
