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
  RentreeReguliere,
} from "./types";

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
}

type Row = Record<string, unknown>;

// Les colonnes de date sont nullable en base : une ligne nouvellement ajoutée peut
// ne pas encore avoir de date choisie par l'utilisateur. "" est la convention interne
// pour "pas de date" ; on la convertit en null uniquement à la frontière Supabase,
// car une chaîne vide n'est pas une valeur "date" valide pour Postgres.
function dateOuNull(dateStr: string): string | null {
  return dateStr || null;
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
  };
}

function rowToAutreDepense(row: Row): AutreDepense {
  return {
    id: row.id as string,
    libelle: row.libelle as string,
    montant: Number(row.montant),
    datePrevue: (row.date_prevue as string | null) ?? "",
    type: row.type as AutreDepense["type"],
  };
}

function financementToRow(companyId: string, f: Financement): Row {
  return {
    id: f.id,
    company_id: companyId,
    libelle: f.libelle,
    montant: f.montant,
    date_encaissement_prevue: dateOuNull(f.dateEncaissementPrevue),
  };
}

function rowToFinancement(row: Row): Financement {
  return {
    id: row.id as string,
    libelle: row.libelle as string,
    montant: Number(row.montant),
    dateEncaissementPrevue: (row.date_encaissement_prevue as string | null) ?? "",
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
  };
}

export async function getOrCreateCompanyForUser(userId: string): Promise<string> {
  const { data: existing, error: selectError } = await client()
    .from("companies")
    .select("id")
    .eq("owner_id", userId)
    .maybeSingle();
  if (selectError) throw selectError;
  if (existing) return existing.id as string;

  const { data: created, error: insertError } = await client()
    .from("companies")
    .insert({ owner_id: userId, name: "Ma société" })
    .select("id")
    .single();
  if (insertError) throw insertError;
  return created.id as string;
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

  const [clientsRows, fournisseursRows, chargesRows, depensesRows, financementsRows, rentreesRows] =
    await Promise.all([
      selectAll("customer_invoices", companyId),
      selectAll("supplier_invoices", companyId),
      selectAll("fixed_charges", companyId),
      selectAll("other_expenses", companyId),
      selectAll("financings", companyId),
      selectAll("recurring_income", companyId),
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

export async function sauvegarderChargeFixe(companyId: string, charge: ChargeFixe): Promise<void> {
  await upsertOne("fixed_charges", chargeFixeToRow(companyId, charge));
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
