import type { SupabaseClient } from "@supabase/supabase-js";
import { supabase } from "./supabaseClient";
import { todayISO } from "./dates";
import {
  SOLDE_BANCAIRE_INITIAL,
  mockAutresDepenses,
  mockChargesFixes,
  mockFacturesClients,
  mockFacturesFournisseurs,
  mockFinancements,
  mockRentreesRegulieres,
} from "./mockData";
import {
  AutreDepense,
  ChargeFixe,
  FactureClient,
  FactureFournisseur,
  Financement,
  HorizonJours,
  LienRapprochement,
  MappingFournisseurCharge,
  RentreeReguliere,
} from "./types";
import { CategorieFacture, CorrespondanceFutur, EtageDepense, estEtageDepense, lireCorrespondance } from "./futurPnl";

export interface DonneesEntreprise {
  soldeInitial: number;
  dateReleve: string;
  horizonJours: HorizonJours;
  facturesClients: FactureClient[];
  facturesFournisseurs: FactureFournisseur[];
  chargesFixes: ChargeFixe[];
  autresDepenses: AutreDepense[];
  financements: Financement[];
  rentreesRegulieres: RentreeReguliere[];
  liensRapprochement: LienRapprochement[];
  mappingsFournisseurs: MappingFournisseurCharge[];
}

type Row = Record<string, unknown>;

// Les colonnes de date sont nullable en base : une ligne nouvellement ajoutée peut
// ne pas encore avoir de date choisie par l'utilisateur. "" est la convention interne
// pour "pas de date" ; on la convertit en null uniquement à la frontière Supabase,
// car une chaîne vide n'est pas une valeur "date" valide pour Postgres.
function dateOuNull(dateStr: string): string | null {
  return dateStr || null;
}

// Étage choisi dans Futur : une valeur hors nomenclature lue en base est traitée comme « aucun choix ».
function etageManuelOuNull(valeur: unknown): EtageDepense | null {
  return estEtageDepense(valeur) ? valeur : null;
}

function categoriesOuNull(valeur: unknown): CategorieFacture[] | null {
  return Array.isArray(valeur) ? (valeur as CategorieFacture[]) : null;
}

function client() {
  if (!supabase) throw new Error("Supabase non configuré");
  return supabase;
}

async function selectAll(table: string, companyId: string): Promise<Row[]> {
  const { data, error } = await client().from(table).select("*").eq("company_id", companyId);
  if (error) throw error;
  return data ?? [];
}

/**
 * Lecture d'une table du rapprochement Charges fixes / factures. Si la migration
 * 20261018_fixed_charge_invoice_matching.sql n'est pas encore appliquée sur cette base (table
 * inexistante), le cockpit doit continuer de se charger normalement : aucun rapprochement.
 */
async function selectAllSiTableExiste(table: string, companyId: string): Promise<Row[]> {
  const { data, error } = await client().from(table).select("*").eq("company_id", companyId);
  if (error) {
    if (error.code === "42P01" || error.code === "PGRST205") return [];
    throw error;
  }
  return data ?? [];
}

async function insertMany(table: string, rows: Row[]): Promise<void> {
  if (rows.length === 0) return;
  const { error } = await client().from(table).insert(rows);
  if (error) throw error;
}

async function upsertOne(table: string, row: Row): Promise<void> {
  const { error } = await client().from(table).upsert(row);
  if (error) throw error;
}

async function deleteOne(table: string, id: string): Promise<void> {
  const { error } = await client().from(table).delete().eq("id", id);
  if (error) throw error;
}

function factureClientToRow(companyId: string, f: FactureClient): Row {
  return {
    id: f.id,
    company_id: companyId,
    facture: f.facture,
    client: f.client,
    montant: f.montant,
    date_echeance: dateOuNull(f.dateEcheance),
    date_encaissement_anticipee: dateOuNull(f.dateEncaissementAnticipee),
    litigieuse: f.litigieuse,
    paid: f.payee,
    paid_at: f.paidAt,
    pennylane_id: f.pennylaneId ?? null,
  };
}

function rowToFactureClient(row: Row): FactureClient {
  return {
    id: row.id as string,
    facture: row.facture as string,
    client: row.client as string,
    montant: Number(row.montant),
    dateEcheance: (row.date_echeance as string | null) ?? "",
    dateEncaissementAnticipee: (row.date_encaissement_anticipee as string | null) ?? "",
    litigieuse: row.litigieuse as boolean,
    payee: Boolean(row.paid),
    paidAt: (row.paid_at as string | null) ?? null,
    settledOn: (row.settled_on as string | null) ?? null,
    pennylaneId: (row.pennylane_id as string | null) ?? null,
  };
}

function factureFournisseurToRow(companyId: string, f: FactureFournisseur): Row {
  return {
    id: f.id,
    company_id: companyId,
    facture: f.facture,
    fournisseur: f.fournisseur,
    montant: f.montant,
    date_echeance: dateOuNull(f.dateEcheance),
    date_paiement_prevue: dateOuNull(f.datePaiementPrevue),
    litigieuse: f.litigieuse,
    paid: f.payee,
    paid_at: f.paidAt,
    pennylane_id: f.pennylaneId ?? null,
    // Ni l'étage P&L ni les catégories Pennylane ne sont renvoyés ici (voir affecterEtagePnlManuel).
    pennylane_supplier_id: f.pennylaneSupplierId ?? null,
  };
}

function rowToFactureFournisseur(row: Row): FactureFournisseur {
  return {
    id: row.id as string,
    facture: row.facture as string,
    fournisseur: row.fournisseur as string,
    montant: Number(row.montant),
    dateEcheance: (row.date_echeance as string | null) ?? "",
    datePaiementPrevue: (row.date_paiement_prevue as string | null) ?? "",
    litigieuse: row.litigieuse as boolean,
    payee: Boolean(row.paid),
    paidAt: (row.paid_at as string | null) ?? null,
    settledOn: (row.settled_on as string | null) ?? null,
    pennylaneId: (row.pennylane_id as string | null) ?? null,
    // Colonnes absentes avant la migration « étage P&L Futur » : « À classer ».
    etagePnlManuel: etageManuelOuNull(row.pnl_stage_manual),
    categoriesPennylane: categoriesOuNull(row.pennylane_categories),
    categoriesLuesLe: (row.pennylane_categories_synced_at as string | null | undefined) ?? null,
    pennylaneSupplierId: (row.pennylane_supplier_id as string | null | undefined) ?? null,
  };
}

function chargeFixeToRow(companyId: string, c: ChargeFixe): Row {
  return {
    id: c.id,
    company_id: companyId,
    libelle: c.libelle,
    montant: c.montant,
    date_prevue: dateOuNull(c.datePrevue),
    recurrence: c.recurrence,
    date_fin: c.dateFin,
    mode_montant: c.modeMontant,
    taux_calcul: c.tauxCalcul,
    source_calcul_id: c.sourceCalculId,
    source_calcul_type: c.sourceCalculType,
    a_couper: c.aCouper,
  };
}

function rowToChargeFixe(row: Row): ChargeFixe {
  return {
    id: row.id as string,
    libelle: row.libelle as string,
    montant: Number(row.montant),
    datePrevue: (row.date_prevue as string | null) ?? "",
    recurrence: row.recurrence as ChargeFixe["recurrence"],
    dateFin: (row.date_fin as string | null) ?? null,
    // Colonnes absentes sur une ligne créée avant la migration "montant calculé" : reste "fixe".
    modeMontant: (row.mode_montant as ChargeFixe["modeMontant"] | undefined) ?? "fixe",
    tauxCalcul: (row.taux_calcul as number | null | undefined) ?? null,
    sourceCalculId: (row.source_calcul_id as string | null | undefined) ?? null,
    sourceCalculType: (row.source_calcul_type as ChargeFixe["sourceCalculType"] | undefined) ?? null,
    // Colonne absente sur une ligne créée avant la migration "à couper" : reste incluse (false).
    aCouper: Boolean(row.a_couper),
    etagePnlManuel: etageManuelOuNull(row.pnl_stage_manual),
  };
}

function autreDepenseToRow(companyId: string, d: AutreDepense): Row {
  return {
    id: d.id,
    company_id: companyId,
    libelle: d.libelle,
    montant: d.montant,
    date_prevue: dateOuNull(d.datePrevue),
    type: d.type,
    facturee: d.facturee,
    payee: d.payee,
  };
}

function rowToAutreDepense(row: Row): AutreDepense {
  return {
    id: row.id as string,
    libelle: row.libelle as string,
    montant: Number(row.montant),
    datePrevue: (row.date_prevue as string | null) ?? "",
    type: row.type as AutreDepense["type"],
    facturee: Boolean(row.facturee),
    // Colonne absente sur une ligne créée avant la migration "Payée" : reste incluse (false).
    payee: Boolean(row.payee),
    etagePnlManuel: etageManuelOuNull(row.pnl_stage_manual),
  };
}

function financementToRow(companyId: string, f: Financement): Row {
  return {
    id: f.id,
    company_id: companyId,
    libelle: f.libelle,
    montant: f.montant,
    date_encaissement_prevue: dateOuNull(f.dateEncaissementPrevue),
    verse: f.verse,
  };
}

function rowToFinancement(row: Row): Financement {
  return {
    id: row.id as string,
    libelle: row.libelle as string,
    montant: Number(row.montant),
    dateEncaissementPrevue: (row.date_encaissement_prevue as string | null) ?? "",
    verse: Boolean(row.verse),
  };
}

function rentreeReguliereToRow(companyId: string, r: RentreeReguliere): Row {
  return {
    id: r.id,
    company_id: companyId,
    libelle: r.libelle,
    montant: r.montant,
    date_debut: dateOuNull(r.dateDebut),
    frequence: r.frequence,
    date_fin: r.dateFin,
    mode_montant: r.modeMontant,
    profil_saisonnalite: r.profilSaisonnalite,
  };
}

function rowToRentreeReguliere(row: Row): RentreeReguliere {
  return {
    id: row.id as string,
    libelle: row.libelle as string,
    montant: Number(row.montant),
    dateDebut: (row.date_debut as string | null) ?? "",
    frequence: row.frequence as RentreeReguliere["frequence"],
    dateFin: (row.date_fin as string | null) ?? null,
    // Colonnes absentes sur une ligne créée avant la migration "saisonnalité" : reste "fixe".
    modeMontant: (row.mode_montant as RentreeReguliere["modeMontant"] | undefined) ?? "fixe",
    profilSaisonnalite: (row.profil_saisonnalite as RentreeReguliere["profilSaisonnalite"] | undefined) ?? null,
  };
}

function lienRapprochementToRow(companyId: string, l: LienRapprochement): Row {
  return {
    id: l.id,
    company_id: companyId,
    fixed_charge_id: l.chargeFixeId,
    supplier_invoice_id: l.factureFournisseurId,
    occurrence_date: l.dateOccurrence,
    status: l.statut === "confirme" ? "confirmed" : "rejected",
    invoice_label: l.factureLibelle,
    supplier_label: l.fournisseurLibelle,
    invoice_amount: l.montantFacture,
    invoice_cash_date: l.dateCashFacture,
    invoice_pennylane_id: l.facturePennylaneId,
    supplier_pennylane_id: l.fournisseurPennylaneId,
    review_dismissed_at: l.revueEcarteeLe,
    // Pas de trigger en base : posé ici à chaque écriture.
    updated_at: new Date().toISOString(),
  };
}

function rowToLienRapprochement(row: Row): LienRapprochement {
  return {
    id: row.id as string,
    chargeFixeId: row.fixed_charge_id as string,
    factureFournisseurId: (row.supplier_invoice_id as string | null) ?? null,
    dateOccurrence: row.occurrence_date as string,
    statut: row.status === "confirmed" ? "confirme" : "refuse",
    factureLibelle: (row.invoice_label as string | null) ?? null,
    fournisseurLibelle: (row.supplier_label as string | null) ?? null,
    montantFacture: row.invoice_amount === null || row.invoice_amount === undefined ? null : Number(row.invoice_amount),
    dateCashFacture: (row.invoice_cash_date as string | null) ?? null,
    facturePennylaneId: (row.invoice_pennylane_id as string | null) ?? null,
    fournisseurPennylaneId: (row.supplier_pennylane_id as string | null) ?? null,
    revueEcarteeLe: (row.review_dismissed_at as string | null) ?? null,
  };
}

function mappingFournisseurToRow(companyId: string, m: MappingFournisseurCharge): Row {
  return {
    id: m.id,
    company_id: companyId,
    fixed_charge_id: m.chargeFixeId,
    pennylane_supplier_id: m.pennylaneSupplierId,
    supplier_name_key: m.cleNom,
    supplier_label: m.libelle,
  };
}

function rowToMappingFournisseur(row: Row): MappingFournisseurCharge {
  return {
    id: row.id as string,
    chargeFixeId: row.fixed_charge_id as string,
    pennylaneSupplierId: (row.pennylane_supplier_id as string | null) ?? null,
    cleNom: row.supplier_name_key as string,
    libelle: row.supplier_label as string,
  };
}

interface CashSettings {
  soldeInitial: number;
  dateReleve: string;
  horizonJours: HorizonJours;
}

async function chargerCashSettings(companyId: string): Promise<CashSettings | null> {
  const { data, error } = await client()
    .from("cash_settings")
    .select("solde_initial, date_releve, horizon_jours")
    .eq("company_id", companyId)
    .maybeSingle();
  if (error) throw error;
  return data
    ? {
        soldeInitial: Number(data.solde_initial),
        dateReleve: data.date_releve as string,
        horizonJours: Number(data.horizon_jours) as HorizonJours,
      }
    : null;
}

async function initialiserAvecDonneesMock(companyId: string): Promise<DonneesEntreprise> {
  const dateReleve = todayISO();
  const facturesClients = mockFacturesClients.map((f) => ({ ...f, id: crypto.randomUUID() }));
  const facturesFournisseurs = mockFacturesFournisseurs.map((f) => ({ ...f, id: crypto.randomUUID() }));
  const chargesFixes = mockChargesFixes.map((c) => ({ ...c, id: crypto.randomUUID() }));
  const autresDepenses = mockAutresDepenses.map((d) => ({ ...d, id: crypto.randomUUID() }));
  const financements = mockFinancements.map((f) => ({ ...f, id: crypto.randomUUID() }));
  const rentreesRegulieres = mockRentreesRegulieres.map((r) => ({ ...r, id: crypto.randomUUID() }));

  await Promise.all([
    insertMany(
      "customer_invoices",
      facturesClients.map((f) => factureClientToRow(companyId, f))
    ),
    insertMany(
      "supplier_invoices",
      facturesFournisseurs.map((f) => factureFournisseurToRow(companyId, f))
    ),
    insertMany(
      "fixed_charges",
      chargesFixes.map((c) => chargeFixeToRow(companyId, c))
    ),
    insertMany(
      "other_expenses",
      autresDepenses.map((d) => autreDepenseToRow(companyId, d))
    ),
    insertMany(
      "financings",
      financements.map((f) => financementToRow(companyId, f))
    ),
    insertMany(
      "recurring_income",
      rentreesRegulieres.map((r) => rentreeReguliereToRow(companyId, r))
    ),
    upsertOne("cash_settings", {
      company_id: companyId,
      solde_initial: SOLDE_BANCAIRE_INITIAL,
      date_releve: dateReleve,
      horizon_jours: 90,
    }),
  ]);

  return {
    soldeInitial: SOLDE_BANCAIRE_INITIAL,
    dateReleve,
    horizonJours: 90,
    facturesClients,
    facturesFournisseurs,
    chargesFixes,
    autresDepenses,
    financements,
    rentreesRegulieres,
    liensRapprochement: [],
    mappingsFournisseurs: [],
  };
}

export async function chargerOuInitialiserDonnees(companyId: string): Promise<DonneesEntreprise> {
  // La ligne cash_settings est créée une seule fois, à la toute première initialisation
  // de la société, et n'est jamais supprimée par les actions de l'utilisateur (contrairement
  // aux factures, qui peuvent légitimement être toutes supprimées). Sa seule présence — et non
  // le nombre de factures — est donc le signal fiable pour savoir si la société a déjà été
  // initialisée, afin de ne jamais re-seeder les données de démo sur une liste vidée par l'utilisateur.
  const cashSettings = await chargerCashSettings(companyId);

  if (cashSettings === null) {
    return initialiserAvecDonneesMock(companyId);
  }

  const [clientsRows, fournisseursRows, chargesRows, depensesRows, financementsRows, rentreesRows, liensRows, mappingsRows] =
    await Promise.all([
      selectAll("customer_invoices", companyId),
      selectAll("supplier_invoices", companyId),
      selectAll("fixed_charges", companyId),
      selectAll("other_expenses", companyId),
      selectAll("financings", companyId),
      selectAll("recurring_income", companyId),
      selectAllSiTableExiste("fixed_charge_invoice_links", companyId),
      selectAllSiTableExiste("fixed_charge_supplier_mappings", companyId),
    ]);

  return {
    soldeInitial: cashSettings.soldeInitial,
    dateReleve: cashSettings.dateReleve,
    horizonJours: cashSettings.horizonJours,
    facturesClients: clientsRows.map(rowToFactureClient),
    facturesFournisseurs: fournisseursRows.map(rowToFactureFournisseur),
    chargesFixes: chargesRows.map(rowToChargeFixe),
    autresDepenses: depensesRows.map(rowToAutreDepense),
    financements: financementsRows.map(rowToFinancement),
    rentreesRegulieres: rentreesRows.map(rowToRentreeReguliere),
    liensRapprochement: liensRows.map(rowToLienRapprochement),
    mappingsFournisseurs: mappingsRows.map(rowToMappingFournisseur),
  };
}

export async function sauvegarderSoldeInitial(companyId: string, soldeInitial: number): Promise<void> {
  await upsertOne("cash_settings", { company_id: companyId, solde_initial: soldeInitial });
}

export async function sauvegarderDateReleve(companyId: string, dateReleve: string): Promise<void> {
  await upsertOne("cash_settings", { company_id: companyId, date_releve: dateReleve });
}

export async function sauvegarderHorizonJours(companyId: string, horizonJours: HorizonJours): Promise<void> {
  await upsertOne("cash_settings", { company_id: companyId, horizon_jours: horizonJours });
}

export async function sauvegarderFactureClient(companyId: string, facture: FactureClient): Promise<void> {
  await upsertOne("customer_invoices", factureClientToRow(companyId, facture));
}

export async function supprimerFactureClient(id: string): Promise<void> {
  await deleteOne("customer_invoices", id);
}

export async function sauvegarderFactureFournisseur(
  companyId: string,
  facture: FactureFournisseur
): Promise<void> {
  await upsertOne("supplier_invoices", factureFournisseurToRow(companyId, facture));
}

export async function supprimerFactureFournisseur(id: string): Promise<void> {
  await deleteOne("supplier_invoices", id);
}

export async function importerFacturesClients(companyId: string, factures: FactureClient[]): Promise<void> {
  await insertMany(
    "customer_invoices",
    factures.map((f) => factureClientToRow(companyId, f))
  );
}

export async function importerFacturesFournisseurs(
  companyId: string,
  factures: FactureFournisseur[]
): Promise<void> {
  await insertMany(
    "supplier_invoices",
    factures.map((f) => factureFournisseurToRow(companyId, f))
  );
}

// Synchronisation Pennylane — marque "Payée" un lot de factures déjà existantes, identifiées par
// leur id Novanta (jamais par pennylane_id ici : le rapprochement a déjà eu lieu côté
// lib/pennylaneInvoiceAdapter.ts). Ne touche STRICTEMENT que paid/paid_at : aucune autre colonne
// (date_echeance, litigieuse, montant...) n'apparaît dans cette requête, donc aucune modification
// utilisateur ne peut jamais être écrasée par un appel de synchronisation (voir diagnostic §10/§13).
export async function marquerFacturesClientsPayees(ids: string[]): Promise<void> {
  if (ids.length === 0) return;
  const { error } = await client()
    .from("customer_invoices")
    .update({ paid: true, paid_at: new Date().toISOString() })
    .in("id", ids);
  if (error) throw error;
}

export async function marquerFacturesFournisseursPayees(ids: string[]): Promise<void> {
  if (ids.length === 0) return;
  const { error } = await client()
    .from("supplier_invoices")
    .update({ paid: true, paid_at: new Date().toISOString() })
    .in("id", ids);
  if (error) throw error;
}

// Synchronisation Pennylane : retire les factures fournisseurs dont la version Pennylane a été
// archivée (voir lib/pennylaneInvoiceAdapter.ts::calculerSynchronisation).
export async function supprimerFacturesFournisseurs(ids: string[]): Promise<void> {
  if (ids.length === 0) return;
  const { error } = await client().from("supplier_invoices").delete().in("id", ids);
  if (error) throw error;
}

export async function sauvegarderChargeFixe(companyId: string, charge: ChargeFixe): Promise<void> {
  await upsertOne("fixed_charges", chargeFixeToRow(companyId, charge));
}

export async function importerChargesFixes(companyId: string, charges: ChargeFixe[]): Promise<void> {
  await insertMany(
    "fixed_charges",
    charges.map((c) => chargeFixeToRow(companyId, c))
  );
}

export async function supprimerChargeFixe(id: string): Promise<void> {
  await deleteOne("fixed_charges", id);
}

export async function sauvegarderAutreDepense(companyId: string, depense: AutreDepense): Promise<void> {
  await upsertOne("other_expenses", autreDepenseToRow(companyId, depense));
}

export async function supprimerAutreDepense(id: string): Promise<void> {
  await deleteOne("other_expenses", id);
}

export async function sauvegarderFinancement(companyId: string, financement: Financement): Promise<void> {
  await upsertOne("financings", financementToRow(companyId, financement));
}

export async function supprimerFinancement(id: string): Promise<void> {
  await deleteOne("financings", id);
}

export async function sauvegarderRentreeReguliere(companyId: string, rentree: RentreeReguliere): Promise<void> {
  await upsertOne("recurring_income", rentreeReguliereToRow(companyId, rentree));
}

export async function supprimerRentreeReguliere(id: string): Promise<void> {
  await deleteOne("recurring_income", id);
}

export type TableDepense = "fixed_charges" | "supplier_invoices" | "other_expenses";

/**
 * Seule écriture de l'étage P&L (cellule du tableau, « Affecter un étage P&L », « Reprendre le
 * classement automatique ») : le SEUL choix manuel (null = le retirer) sur les lignes désignées de
 * la société. Aucune autre colonne n'est envoyée : montants, dates, récurrence, réglages de
 * prévision restent intacts. À l'inverse, les sauvegardes habituelles d'une ligne n'envoient
 * jamais pnl_stage_manual : une saisie en cours ne peut pas effacer un étage choisi entre-temps.
 */
export async function affecterEtagePnlManuel(
  table: TableDepense,
  companyId: string,
  ids: string[],
  etage: EtageDepense | null
): Promise<void> {
  if (ids.length === 0) return;
  const { error } = await client().from(table).update({ pnl_stage_manual: etage }).eq("company_id", companyId).in("id", ids);
  if (error) throw error;
}

// --- Rapprochement Charges fixes / factures fournisseurs (voir lib/rapprochementChargesFixes.ts) ---

// Synchronisation Pennylane : renseigne l'identifiant fournisseur d'une facture déjà importée.
// Ne touche que cette colonne, et seulement si elle est encore vide (jamais d'écrasement).
export async function renseignerFournisseursPennylane(
  renseignements: { id: string; pennylaneSupplierId: string }[]
): Promise<void> {
  for (const { id, pennylaneSupplierId } of renseignements) {
    const { error } = await client()
      .from("supplier_invoices")
      .update({ pennylane_supplier_id: pennylaneSupplierId })
      .eq("id", id)
      .is("pennylane_supplier_id", null);
    if (error) throw error;
  }
}

/** Crée ou met à jour une décision de rapprochement (confirmée ou refusée). */
export async function sauvegarderLienRapprochement(companyId: string, lien: LienRapprochement): Promise<void> {
  await upsertOne("fixed_charge_invoice_links", lienRapprochementToRow(companyId, lien));
}

export async function supprimerLienRapprochement(id: string): Promise<void> {
  await deleteOne("fixed_charge_invoice_links", id);
}

// Refus portés par une facture sans identifiant Pennylane : ils ne pourront plus jamais être
// reconnus une fois la facture supprimée, autant ne pas les conserver.
export async function supprimerRefusSansIdentitePennylane(factureFournisseurIds: string[]): Promise<void> {
  if (factureFournisseurIds.length === 0) return;
  const { error } = await client()
    .from("fixed_charge_invoice_links")
    .delete()
    .in("supplier_invoice_id", factureFournisseurIds)
    .eq("status", "rejected")
    .is("invoice_pennylane_id", null);
  if (error) throw error;
}

export async function sauvegarderMappingFournisseur(companyId: string, mapping: MappingFournisseurCharge): Promise<void> {
  await upsertOne("fixed_charge_supplier_mappings", mappingFournisseurToRow(companyId, mapping));
}

// --- Doublons de factures : décisions de l'utilisateur (20261021_invoice_duplicate_merges.sql) ---

export type SensFacture = "client" | "fournisseur";
const DIRECTION: Record<SensFacture, string> = { client: "customer", fournisseur: "supplier" };

export interface DecisionDoublon {
  sens: SensFacture;
  cle: string; // clePaire des deux lignes (lib/doublonsFactures.ts)
  decision: "fusion" | "distinct";
  // Fusion : identifiant Pennylane de la ligne retirée, que la synchronisation ne réimporte plus.
  pennylaneIdRetire: string | null;
}

// Table absente (base pas encore migrée) : aucune décision, l'application reste utilisable.
const tableAbsente = (error: { code?: string } | null) => error?.code === "42P01" || error?.code === "PGRST205";

/** Décisions sur les doublons : paires écartées (« Ce ne sont pas des doublons ») et fusions. */
export async function chargerDecisionsDoublons(companyId: string): Promise<DecisionDoublon[]> {
  const { data, error } = await client()
    .from("invoice_duplicate_decisions")
    .select("direction, first_invoice_id, second_invoice_id, decision, removed_pennylane_id")
    .eq("company_id", companyId);
  if (tableAbsente(error)) return [];
  if (error) throw error;
  return ((data ?? []) as Row[]).map((row) => ({
    sens: row.direction === "customer" ? "client" : "fournisseur",
    cle: [row.first_invoice_id as string, row.second_invoice_id as string].sort().join("|"),
    decision: row.decision === "merged" ? "fusion" : "distinct",
    pennylaneIdRetire: (row.removed_pennylane_id as string | null) ?? null,
  }));
}

const pairePourRow = (idA: string, idB: string) => {
  const [premier, second] = [idA, idB].sort();
  return { first_invoice_id: premier, second_invoice_id: second };
};
const CONFLIT_PAIRE = "company_id,direction,first_invoice_id,second_invoice_id";

/** « Ce ne sont pas des doublons » : la paire n'est plus jamais proposée, même après rechargement. */
export async function enregistrerPaireDistincte(companyId: string, sens: SensFacture, idA: string, idB: string): Promise<void> {
  const { error } = await client()
    .from("invoice_duplicate_decisions")
    .upsert({ company_id: companyId, direction: DIRECTION[sens], ...pairePourRow(idA, idB), decision: "distinct" }, { onConflict: CONFLIT_PAIRE });
  if (error) throw error;
}

/**
 * Correspondance catégorie -> étage de la société, lue par la fonction future_pnl_correspondance
 * (identifiants et étages seulement) : disponible sans le module Passé. Absente (migration non
 * passée, erreur) : aucune correspondance, tout reste classable à la main.
 */
export async function chargerCorrespondanceFutur(): Promise<CorrespondanceFutur> {
  const { data, error } = await client().rpc("future_pnl_correspondance");
  if (error) throw error;
  return lireCorrespondance(data);
}

/**
 * Fusion confirmée, dans un ordre qui ne perd rien en cas d'échec et qu'on peut rejouer :
 *  1. la décision est enregistrée avec l'état des deux lignes AVANT fusion et les choix faits
 *     (historique : qui, quand, quoi — rejouer la même fusion la met simplement à jour) ;
 *  2. la ligne de référence reçoit les valeurs retenues ;
 *  3. `avantRetrait` (rattachements à déplacer, propre à l'appelant) ;
 *  4. la ligne retirée est supprimée — son contenu reste dans l'historique de la décision.
 */
export async function enregistrerFusion<T extends FactureClient | FactureFournisseur>(
  companyId: string,
  sens: SensFacture,
  fusion: { avant: [T, T]; reference: T; retiree: T; pennylaneIdRetire: string | null; choix: Record<string, string> },
  avantRetrait: () => Promise<void> = async () => {}
): Promise<void> {
  const versRow = (f: T) => (sens === "client" ? factureClientToRow(companyId, f as FactureClient) : factureFournisseurToRow(companyId, f as FactureFournisseur));
  const table = sens === "client" ? "customer_invoices" : "supplier_invoices";
  const { error } = await client()
    .from("invoice_duplicate_decisions")
    .upsert(
      {
        company_id: companyId,
        direction: DIRECTION[sens],
        ...pairePourRow(fusion.avant[0].id, fusion.avant[1].id),
        decision: "merged",
        kept_invoice_id: fusion.reference.id,
        removed_invoice_id: fusion.retiree.id,
        removed_pennylane_id: fusion.pennylaneIdRetire,
        snapshot: { avant: fusion.avant.map(versRow), apres: versRow(fusion.reference), choix: fusion.choix },
        decided_at: new Date().toISOString(),
      },
      { onConflict: CONFLIT_PAIRE }
    );
  if (error) throw error;
  await upsertOne(table, versRow(fusion.reference));
  await avantRetrait();
  await deleteOne(table, fusion.retiree.id);
}

/**
 * Document d'une facture liée à Pennylane, actualisé à la synchronisation : seules ces colonnes
 * sont écrites (jamais Payée ni les autres réglages, mis à jour séparément).
 */
export async function actualiserDocumentsFactures(
  sens: SensFacture,
  misesAJour: { id: string; facture: string; tiers: string; montant: number; dateEcheance: string; datePrevue: string | null }[]
): Promise<void> {
  const table = sens === "client" ? "customer_invoices" : "supplier_invoices";
  const colonneTiers = sens === "client" ? "client" : "fournisseur";
  const colonneDatePrevue = sens === "client" ? "date_encaissement_anticipee" : "date_paiement_prevue";
  for (const m of misesAJour) {
    const { error } = await client()
      .from(table)
      .update({
        facture: m.facture,
        [colonneTiers]: m.tiers,
        montant: m.montant,
        date_echeance: dateOuNull(m.dateEcheance),
        ...(m.datePrevue !== null ? { [colonneDatePrevue]: dateOuNull(m.datePrevue) } : {}),
      })
      .eq("id", m.id);
    if (error) throw error;
  }
}

// --- Lecture serveur (clé service_role) : prévision de référence, lib/fiabiliteProjection.ts ---

const TAILLE_PAGE_SERVEUR = 1000;

/** Toutes les lignes d'une table pour une société, paginées : jamais une liste tronquée. */
async function selectToutServeur(admin: SupabaseClient, table: string, companyId: string, siTableExiste = false): Promise<Row[]> {
  const toutes: Row[] = [];
  for (let debut = 0; ; debut += TAILLE_PAGE_SERVEUR) {
    const { data, error } = await admin
      .from(table)
      .select("*")
      .eq("company_id", companyId)
      .order("id", { ascending: true })
      .range(debut, debut + TAILLE_PAGE_SERVEUR - 1);
    if (error) {
      if (siTableExiste && (error.code === "42P01" || error.code === "PGRST205")) return [];
      throw error;
    }
    const lignes = (data ?? []) as Row[];
    toutes.push(...lignes);
    if (lignes.length < TAILLE_PAGE_SERVEUR) return toutes;
  }
}

/** Données de prévision d'une société, lues côté serveur (aucune donnée de démonstration créée). */
export async function chargerDonneesPrevisionServeur(admin: SupabaseClient, companyId: string) {
  const [clients, fournisseurs, charges, depenses, financementsRows, rentrees, liens] = await Promise.all([
    selectToutServeur(admin, "customer_invoices", companyId),
    selectToutServeur(admin, "supplier_invoices", companyId),
    selectToutServeur(admin, "fixed_charges", companyId),
    selectToutServeur(admin, "other_expenses", companyId),
    selectToutServeur(admin, "financings", companyId),
    selectToutServeur(admin, "recurring_income", companyId),
    selectToutServeur(admin, "fixed_charge_invoice_links", companyId, true),
  ]);
  return {
    facturesClients: clients.map(rowToFactureClient),
    facturesFournisseurs: fournisseurs.map(rowToFactureFournisseur),
    chargesFixes: charges.map(rowToChargeFixe),
    autresDepenses: depenses.map(rowToAutreDepense),
    financements: financementsRows.map(rowToFinancement),
    rentreesRegulieres: rentrees.map(rowToRentreeReguliere),
    liensRapprochement: liens.map(rowToLienRapprochement),
  };
}

/** Correspondance P&L de la société lue côté serveur (même contenu que future_pnl_correspondance). */
export async function chargerCorrespondanceServeur(admin: SupabaseClient, companyId: string): Promise<CorrespondanceFutur> {
  const [{ data: reglages, error: e1 }, mappings] = await Promise.all([
    admin.from("past_settings").select("reporting_analytic_group_id").eq("organization_id", companyId).maybeSingle(),
    (async () => {
      const toutes: Row[] = [];
      for (let debut = 0; ; debut += TAILLE_PAGE_SERVEUR) {
        const { data, error } = await admin
          .from("past_category_mappings")
          .select("source_category_id, source_group_id, pnl_stage")
          .eq("organization_id", companyId)
          .not("pnl_stage", "is", null)
          .order("source_category_id", { ascending: true })
          .range(debut, debut + TAILLE_PAGE_SERVEUR - 1);
        if (error) throw error;
        toutes.push(...((data ?? []) as Row[]));
        if ((data ?? []).length < TAILLE_PAGE_SERVEUR) return toutes;
      }
    })(),
  ]);
  if (e1) throw e1;
  return lireCorrespondance({
    axe: (reglages as Row | null)?.reporting_analytic_group_id ?? null,
    correspondances: mappings.map((m) => ({ id: m.source_category_id, axe: m.source_group_id, etage: m.pnl_stage })),
  });
}
