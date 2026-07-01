import { supabase } from "./supabaseClient";
import {
  SOLDE_BANCAIRE_INITIAL,
  mockAutresDepenses,
  mockChargesFixes,
  mockFacturesClients,
  mockFacturesFournisseurs,
  mockFinancements,
} from "./mockData";
import { AutreDepense, ChargeFixe, FactureClient, FactureFournisseur, Financement } from "./types";

export interface DonneesEntreprise {
  soldeInitial: number;
  facturesClients: FactureClient[];
  facturesFournisseurs: FactureFournisseur[];
  chargesFixes: ChargeFixe[];
  autresDepenses: AutreDepense[];
  financements: Financement[];
}

type Row = Record<string, unknown>;

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
    date_echeance: f.dateEcheance,
    date_encaissement_anticipee: f.dateEncaissementAnticipee,
    litigieuse: f.litigieuse,
  };
}

function rowToFactureClient(row: Row): FactureClient {
  return {
    id: row.id as string,
    facture: row.facture as string,
    client: row.client as string,
    montant: Number(row.montant),
    dateEcheance: row.date_echeance as string,
    dateEncaissementAnticipee: row.date_encaissement_anticipee as string,
    litigieuse: row.litigieuse as boolean,
  };
}

function factureFournisseurToRow(companyId: string, f: FactureFournisseur): Row {
  return {
    id: f.id,
    company_id: companyId,
    facture: f.facture,
    fournisseur: f.fournisseur,
    montant: f.montant,
    date_echeance: f.dateEcheance,
    date_paiement_prevue: f.datePaiementPrevue,
    litigieuse: f.litigieuse,
  };
}

function rowToFactureFournisseur(row: Row): FactureFournisseur {
  return {
    id: row.id as string,
    facture: row.facture as string,
    fournisseur: row.fournisseur as string,
    montant: Number(row.montant),
    dateEcheance: row.date_echeance as string,
    datePaiementPrevue: row.date_paiement_prevue as string,
    litigieuse: row.litigieuse as boolean,
  };
}

function chargeFixeToRow(companyId: string, c: ChargeFixe): Row {
  return {
    id: c.id,
    company_id: companyId,
    libelle: c.libelle,
    montant: c.montant,
    date_prevue: c.datePrevue,
    recurrence: c.recurrence,
  };
}

function rowToChargeFixe(row: Row): ChargeFixe {
  return {
    id: row.id as string,
    libelle: row.libelle as string,
    montant: Number(row.montant),
    datePrevue: row.date_prevue as string,
    recurrence: row.recurrence as ChargeFixe["recurrence"],
  };
}

function autreDepenseToRow(companyId: string, d: AutreDepense): Row {
  return {
    id: d.id,
    company_id: companyId,
    libelle: d.libelle,
    montant: d.montant,
    date_prevue: d.datePrevue,
    type: d.type,
  };
}

function rowToAutreDepense(row: Row): AutreDepense {
  return {
    id: row.id as string,
    libelle: row.libelle as string,
    montant: Number(row.montant),
    datePrevue: row.date_prevue as string,
    type: row.type as AutreDepense["type"],
  };
}

function financementToRow(companyId: string, f: Financement): Row {
  return {
    id: f.id,
    company_id: companyId,
    libelle: f.libelle,
    montant: f.montant,
    date_encaissement_prevue: f.dateEncaissementPrevue,
  };
}

function rowToFinancement(row: Row): Financement {
  return {
    id: row.id as string,
    libelle: row.libelle as string,
    montant: Number(row.montant),
    dateEncaissementPrevue: row.date_encaissement_prevue as string,
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

async function chargerSoldeInitial(companyId: string): Promise<number | null> {
  const { data, error } = await client()
    .from("cash_settings")
    .select("solde_initial")
    .eq("company_id", companyId)
    .maybeSingle();
  if (error) throw error;
  return data ? Number(data.solde_initial) : null;
}

async function initialiserAvecDonneesMock(companyId: string): Promise<DonneesEntreprise> {
  const facturesClients = mockFacturesClients.map((f) => ({ ...f, id: crypto.randomUUID() }));
  const facturesFournisseurs = mockFacturesFournisseurs.map((f) => ({ ...f, id: crypto.randomUUID() }));
  const chargesFixes = mockChargesFixes.map((c) => ({ ...c, id: crypto.randomUUID() }));
  const autresDepenses = mockAutresDepenses.map((d) => ({ ...d, id: crypto.randomUUID() }));
  const financements = mockFinancements.map((f) => ({ ...f, id: crypto.randomUUID() }));

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
    upsertOne("cash_settings", { company_id: companyId, solde_initial: SOLDE_BANCAIRE_INITIAL }),
  ]);

  return {
    soldeInitial: SOLDE_BANCAIRE_INITIAL,
    facturesClients,
    facturesFournisseurs,
    chargesFixes,
    autresDepenses,
    financements,
  };
}

export async function chargerOuInitialiserDonnees(companyId: string): Promise<DonneesEntreprise> {
  const [clientsRows, fournisseursRows] = await Promise.all([
    selectAll("customer_invoices", companyId),
    selectAll("supplier_invoices", companyId),
  ]);

  const dejaInitialise = clientsRows.length > 0 || fournisseursRows.length > 0;
  if (!dejaInitialise) {
    return initialiserAvecDonneesMock(companyId);
  }

  const [chargesRows, depensesRows, financementsRows, soldeInitial] = await Promise.all([
    selectAll("fixed_charges", companyId),
    selectAll("other_expenses", companyId),
    selectAll("financings", companyId),
    chargerSoldeInitial(companyId),
  ]);

  return {
    soldeInitial: soldeInitial ?? SOLDE_BANCAIRE_INITIAL,
    facturesClients: clientsRows.map(rowToFactureClient),
    facturesFournisseurs: fournisseursRows.map(rowToFactureFournisseur),
    chargesFixes: chargesRows.map(rowToChargeFixe),
    autresDepenses: depensesRows.map(rowToAutreDepense),
    financements: financementsRows.map(rowToFinancement),
  };
}

export async function sauvegarderSoldeInitial(companyId: string, soldeInitial: number): Promise<void> {
  await upsertOne("cash_settings", { company_id: companyId, solde_initial: soldeInitial });
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
