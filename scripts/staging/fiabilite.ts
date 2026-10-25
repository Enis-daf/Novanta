/**
 * Fiabilité de la projection — scénarios de test sur le STAGING uniquement (QANNT TEST).
 *
 *   npm run staging:fiabilite                          état des lieux, lecture seule
 *   npm run staging:fiabilite -- --scenarios           module Passé, correspondance, transactions et références de test
 *   npm run staging:fiabilite -- --capture <ISO>       capture planifiée simulée à cet instant (vrai code serveur)
 *   npm run staging:fiabilite -- --api <url> <type> [debut]   appelle /api/futur/fiabilite en tant qu'utilisateur de test
 *   npm run staging:fiabilite -- --nettoyer            retire toutes les données de test de ce script
 *
 * Refuse de s'exécuter hors staging (garde-fou contexteStaging). Données créées : libellés préfixés
 * « [TEST fiabilité] », identifiants source « test-fiabilite-… », axe « test-fiabilite-axe ».
 *
 * Scénarios (mois de 2026, montants TTC) :
 *   avril     prévision exacte (sert au trimestre)
 *   mai       prévision exacte, avec TVA et virement interne
 *   juin      dépenses surestimées (100 k prévus, 92 k réels) et une sortie non catégorisée
 *   juillet   dépenses sous-estimées (100 k prévus, 108 k réels), encaissements 150 -> 138 k
 *   août      erreurs opposées : coûts directs +10 k, coûts de structure −10 k (total juste)
 *   septembre transactions sans prévision de référence
 *   T2        référence trimestrielle propre (avril–juin), différente de la somme des mois
 */
import { createClient, SupabaseClient } from "@supabase/supabase-js";
import { connecterStaging, contexteStaging, lancer, RefusGardeFou } from "./garde";
import { capturerSociete } from "../../lib/captureReferences";
import { CLES_GROUPES, CleGroupe, instantCloture, LignePrevue, PeriodeFiabilite, TotauxFlux } from "../../lib/fiabiliteProjection";

const PREFIXE = "[TEST fiabilité]";
const SOURCE_TEST = "test-fiabilite-";
const AXE_TEST = "test-fiabilite-axe";

type Row = Record<string, unknown>;

function adminStaging(): SupabaseClient {
  contexteStaging();
  return createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } });
}

async function utilisateurTest(admin: SupabaseClient) {
  const { data, error } = await admin.auth.admin.listUsers();
  if (error) throw error;
  const user = data.users.find((u) => u.email === process.env.STAGING_USER_EMAIL);
  if (!user) throw new RefusGardeFou("Utilisateur de test du staging introuvable.");
  return user;
}

async function societeTest(admin: SupabaseClient): Promise<string> {
  const user = await utilisateurTest(admin);
  const { data, error } = await admin.from("companies").select("id").eq("owner_id", user.id).single();
  if (error) throw error;
  return (data as Row).id as string;
}

/** Jeton de session de l'utilisateur de test (lien magique généré côté admin, jamais affiché). */
async function jetonTest(admin: SupabaseClient): Promise<string> {
  const user = await utilisateurTest(admin);
  const { data, error } = await admin.auth.admin.generateLink({ type: "magiclink", email: user.email! });
  if (error) throw error;
  const anonyme = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY!, { auth: { persistSession: false } });
  const { data: session, error: e2 } = await anonyme.auth.verifyOtp({ type: "magiclink", token_hash: data.properties.hashed_token });
  if (e2 || !session.session) throw e2 ?? new Error("Session de test indisponible.");
  return session.session.access_token;
}

// --- Scénarios ----------------------------------------------------------------------------------------

type Montants = { encaissements: number } & Partial<Record<CleGroupe, number>>;

const CATEGORIES: { nom: string; etage: string; groupe: CleGroupe | null }[] = [
  { nom: "Ventes", etage: "revenue", groupe: null },
  { nom: "Achats", etage: "gross_margin", groupe: "gross_margin" },
  { nom: "Publicité", etage: "contribution_margin", groupe: "contribution_margin" },
  { nom: "Loyer et logiciels", etage: "ebitda", groupe: "ebitda" },
  { nom: "Exceptionnel", etage: "extra_pnl", groupe: "extra_pnl" },
  { nom: "TVA", etage: "vat", groupe: "extra_pnl" },
  { nom: "Virement interne", etage: "financing", groupe: "financing" },
];

interface Scenario {
  periode: PeriodeFiabilite;
  prevu: Montants | null; // null = pas de référence
  reel: Montants;
  tvaReel?: number; // part TVA (dans extra_pnl) payée réellement
  sansCategorie?: number; // sortie réelle non catégorisée
}

const mois = (m: number): PeriodeFiabilite => {
  const fin = new Date(2026, m, 0).getDate();
  const mm = String(m).padStart(2, "0");
  return { type: "month", debut: `2026-${mm}-01`, fin: `2026-${mm}-${fin}` };
};

const SCENARIOS: Scenario[] = [
  { periode: mois(4), prevu: { encaissements: 120000, gross_margin: 35000, contribution_margin: 8000, ebitda: 50000 }, reel: { encaissements: 120000, gross_margin: 35000, contribution_margin: 8000, ebitda: 50000 } },
  {
    periode: mois(5),
    prevu: { encaissements: 150000, gross_margin: 40000, contribution_margin: 10000, ebitda: 50000, extra_pnl: 5000, financing: 3000 },
    reel: { encaissements: 150000, gross_margin: 40000, contribution_margin: 10000, ebitda: 50000, extra_pnl: 5000, financing: 3000 },
    tvaReel: 5000,
  },
  { periode: mois(6), prevu: { encaissements: 150000, gross_margin: 40000, contribution_margin: 10000, ebitda: 50000 }, reel: { encaissements: 150000, gross_margin: 36000, contribution_margin: 8000, ebitda: 46000 }, sansCategorie: 2000 },
  { periode: mois(7), prevu: { encaissements: 150000, gross_margin: 40000, contribution_margin: 10000, ebitda: 50000 }, reel: { encaissements: 138000, gross_margin: 46000, contribution_margin: 12000, ebitda: 50000 } },
  { periode: mois(8), prevu: { encaissements: 150000, gross_margin: 40000, contribution_margin: 10000, ebitda: 50000 }, reel: { encaissements: 150000, gross_margin: 50000, contribution_margin: 10000, ebitda: 40000 } },
  { periode: mois(9), prevu: null, reel: { encaissements: 140000, gross_margin: 42000, contribution_margin: 9000, ebitda: 50000 } },
];

// Référence trimestrielle propre au T2, arrêtée au 31 mars : volontairement différente de la somme
// des références mensuelles (une prévision initiale, pas trois prévisions révisées).
const T2: PeriodeFiabilite = { type: "quarter", debut: "2026-04-01", fin: "2026-06-30" };
const PREVU_T2: Montants = { encaissements: 400000, gross_margin: 110000, contribution_margin: 30000, ebitda: 150000 };

function totaux(m: Montants): TotauxFlux {
  const parGroupe = Object.fromEntries(CLES_GROUPES.map((c) => [c, m[c] ?? 0])) as Record<CleGroupe, number>;
  const decaissements = CLES_GROUPES.reduce((s, c) => s + parGroupe[c], 0);
  return { encaissements: m.encaissements, decaissements, net: m.encaissements - decaissements, decaissementsParGroupe: parGroupe };
}

function lignesReference(periode: PeriodeFiabilite, m: Montants): LignePrevue[] {
  const jour = (j: number) => `${periode.debut.slice(0, 8)}${String(j).padStart(2, "0")}`;
  const lignes: LignePrevue[] = [
    { source: "facture_client", sourceId: "test-client", libelle: `${PREFIXE} Factures clients`, date: jour(10), montant: m.encaissements * 0.6, groupe: null, etage: null, provenance: null },
    { source: "rentree_reguliere", sourceId: "test-rentree", libelle: `${PREFIXE} Ventes récurrentes`, date: jour(20), montant: m.encaissements * 0.4, groupe: null, etage: null, provenance: null },
  ];
  for (const cle of CLES_GROUPES) {
    const montant = m[cle] ?? 0;
    if (!montant) continue;
    lignes.push({
      source: cle === "ebitda" ? "charge_fixe" : "facture_fournisseur",
      sourceId: `test-${cle}`,
      libelle: `${PREFIXE} ${CATEGORIES.find((c) => c.groupe === cle)?.nom ?? cle}`,
      date: jour(cle === "ebitda" ? 5 : 15),
      montant: -montant,
      groupe: cle,
      etage: cle === CLE_A_CLASSER_TEST ? null : (cle as LignePrevue["etage"]),
      provenance: "manuel",
    });
  }
  return lignes;
}
const CLE_A_CLASSER_TEST: CleGroupe = "a_classer";

async function scenarios(admin: SupabaseClient, companyId: string) {
  const maintenant = new Date().toISOString();
  const verifier = (e: { code?: string; message?: string } | null, quoi: string) => {
    if (e) throw new Error(`${quoi} : ${e.message ?? e.code}`);
  };

  // Module Passé, axe et correspondance de test.
  verifier((await admin.from("organization_modules").upsert({ organization_id: companyId, module_key: "past", enabled: true }, { onConflict: "organization_id,module_key" })).error, "module");
  verifier((await admin.from("past_settings").upsert({ organization_id: companyId, reporting_analytic_group_id: AXE_TEST }, { onConflict: "organization_id" })).error, "axe");
  verifier((await admin.from("past_analytic_groups").upsert({ organization_id: companyId, group_id: AXE_TEST, name: `${PREFIXE} Axe` }, { onConflict: "organization_id,group_id" })).error, "groupe analytique");
  verifier(
    (
      await admin.from("past_category_mappings").upsert(
        CATEGORIES.map((c) => ({ organization_id: companyId, source_category_id: `${SOURCE_TEST}${c.nom}`, source_category_name: c.nom, source_group_id: AXE_TEST, pnl_stage: c.etage })),
        { onConflict: "organization_id,source_category_id" }
      )
    ).error,
    "correspondance"
  );

  // Transactions bancaires réelles des scénarios.
  let n = 0;
  const transactions: Row[] = [];
  const categories: { source: string; categorie: string }[] = [];
  for (const s of SCENARIOS) {
    const jour = (j: number) => `${s.periode.debut.slice(0, 8)}${String(j).padStart(2, "0")}`;
    const ajouter = (date: string, montant: number, categorie: string | null, libelle: string) => {
      const source = `${SOURCE_TEST}${++n}`;
      transactions.push({ organization_id: companyId, source_type: "pennylane", source_transaction_id: source, transaction_date: date, label: `${PREFIXE} ${libelle}`, amount: montant, currency: "EUR", synced_at: maintenant });
      if (categorie) categories.push({ source, categorie });
    };
    ajouter(jour(9), s.reel.encaissements * 0.5, "Ventes", "Encaissement client");
    ajouter(jour(22), s.reel.encaissements * 0.5, "Ventes", "Encaissement client");
    for (const c of CATEGORIES.filter((x) => x.groupe)) {
      let montant = s.reel[c.groupe as CleGroupe] ?? 0;
      if (c.nom === "Exceptionnel") montant -= s.tvaReel ?? 0;
      if (c.nom === "TVA") montant = s.tvaReel ?? 0;
      if (montant > 0) ajouter(jour(c.groupe === "ebitda" ? 5 : 16), -montant, c.nom, c.nom);
    }
    if (s.sansCategorie) ajouter(jour(25), -s.sansCategorie, null, "Prélèvement non catégorisé");
  }
  verifier((await admin.from("past_transactions").upsert(transactions, { onConflict: "organization_id,source_type,source_transaction_id" })).error, "transactions");
  const { data: inserees, error } = await admin.from("past_transactions").select("id, source_transaction_id").eq("organization_id", companyId).like("source_transaction_id", `${SOURCE_TEST}%`);
  verifier(error, "relecture des transactions");
  const idParSource = new Map(((inserees ?? []) as Row[]).map((r) => [r.source_transaction_id as string, r.id as string]));
  verifier((await admin.from("past_transaction_categories").delete().in("transaction_id", [...idParSource.values()])).error, "affectations (purge)");
  verifier(
    (
      await admin.from("past_transaction_categories").insert(
        categories.map((c) => ({
          organization_id: companyId,
          transaction_id: idParSource.get(c.source),
          analytic_group_id: AXE_TEST,
          analytic_category_id: `${SOURCE_TEST}${c.categorie}`,
          analytic_category_name: c.categorie,
          weight: 1,
        }))
      )
    ).error,
    "affectations"
  );

  // Synchronisation complète couvrant la période, après sa fin (réalisé complet).
  verifier((await admin.from("past_sync_runs").insert({ organization_id: companyId, period_start: "2026-01-01", period_end: "2026-10-22", synced_at: maintenant, complete: true, transaction_count: transactions.length })).error, "synchronisation");

  // Références de test (captured_at = maintenant : jamais antidatées). Trimestre T2 en plus.
  const references = [
    ...SCENARIOS.filter((s) => s.prevu).map((s) => ({ periode: s.periode, prevu: s.prevu! })),
    { periode: T2, prevu: PREVU_T2 },
  ].map(({ periode, prevu }) => ({
    company_id: companyId,
    period_kind: periode.type,
    period_start: periode.debut,
    period_end: periode.fin,
    reference_at: instantCloture(periode).toISOString(),
    captured_at: maintenant,
    status: "official",
    capture_mode: "after_close_unchanged",
    engine_version: 1,
    totals: totaux(prevu),
    lines: lignesReference(periode, prevu),
    coverage: { debut: periode.debut, fin: periode.fin, jours: 0, occurrencesIndisponibles: [], test: true },
  }));
  verifier((await admin.from("future_forecast_references").upsert(references, { onConflict: "company_id,period_kind,period_start,status", ignoreDuplicates: true })).error, "références");

  // Marqueur d'installation de la migration (le staging l'a reçue avant son ajout).
  verifier((await admin.from("future_change_events").upsert({ company_id: companyId, minute: new Date(Math.floor(Date.now() / 60000) * 60000).toISOString(), changed_at: maintenant }, { onConflict: "company_id,minute" })).error, "marqueur");

  console.log(`Scénarios créés : ${transactions.length} transactions, ${references.length} références (dont T2).`);
}

async function nettoyer(companyId: string) {
  // Connexion Postgres directe : les références officielles sont figées par trigger, même pour la
  // clé service_role. Le retrait des données de TEST passe le trigger, sur le staging seulement.
  const { client } = await connecterStaging();
  try {
    await client.query("begin");
    await client.query("set local session_replication_role = replica");
    await client.query("delete from future_accuracy_results where company_id = $1", [companyId]);
    await client.query("delete from future_forecast_references where company_id = $1", [companyId]);
    await client.query("set local session_replication_role = origin");
    await client.query("delete from past_sync_runs where organization_id = $1", [companyId]);
    await client.query("delete from past_transactions where organization_id = $1 and source_transaction_id like $2", [companyId, `${SOURCE_TEST}%`]);
    await client.query("delete from past_category_mappings where organization_id = $1 and source_category_id like $2", [companyId, `${SOURCE_TEST}%`]);
    await client.query("delete from past_category_mapping_history where organization_id = $1 and source_category_id like $2", [companyId, `${SOURCE_TEST}%`]);
    await client.query("delete from past_analytic_groups where organization_id = $1 and group_id = $2", [companyId, AXE_TEST]);
    await client.query("delete from past_settings where organization_id = $1 and reporting_analytic_group_id = $2", [companyId, AXE_TEST]);
    await client.query("delete from organization_modules where organization_id = $1 and module_key = 'past'", [companyId]);
    await client.query("commit");
    console.log("Données de test retirées (références, résultats, transactions, correspondance, module Passé).");
  } catch (erreur) {
    await client.query("rollback");
    throw erreur;
  } finally {
    await client.end();
  }
}

async function etat(admin: SupabaseClient, companyId: string) {
  const compter = async (table: string, colonne: string) => {
    const { count, error } = await admin.from(table).select("*", { count: "exact", head: true }).eq(colonne, companyId);
    return error ? `erreur ${error.code}` : count;
  };
  const { data: modules } = await admin.from("organization_modules").select("module_key, enabled").eq("organization_id", companyId);
  const { data: reglages } = await admin.from("past_settings").select("reporting_analytic_group_id").eq("organization_id", companyId).maybeSingle();
  const { data: refs } = await admin.from("future_forecast_references").select("period_kind, period_start, status, capture_mode, captured_at").eq("company_id", companyId).order("period_start");
  console.log(
    JSON.stringify(
      {
        societe: companyId,
        modules,
        axe: (reglages as Row | null)?.reporting_analytic_group_id ?? null,
        transactions: await compter("past_transactions", "organization_id"),
        synchronisations: await compter("past_sync_runs", "organization_id"),
        references: refs,
        resultats: await compter("future_accuracy_results", "company_id"),
        evenements: await compter("future_change_events", "company_id"),
      },
      null,
      2
    )
  );
}

async function api(admin: SupabaseClient, base: string, type: string, debut: string | undefined) {
  const jeton = await jetonTest(admin);
  const url = `${base}/api/futur/fiabilite?type=${type}${debut ? `&debut=${debut}` : ""}`;
  const res = await fetch(url, { headers: { Authorization: `Bearer ${jeton}` } });
  const data = (await res.json()) as Row;
  if (!res.ok) {
    console.log(`HTTP ${res.status}`, data);
    return;
  }
  const detail = data.detail as Row;
  const c = detail.comparaison as Row | null;
  const p = (x: unknown) => {
    const v = x as { statut: string; valeur?: number } | null;
    return !v ? null : v.statut === "score" ? `${Math.round(v.valeur! * 100) / 100} %` : v.statut;
  };
  console.log(
    JSON.stringify(
      {
        periode: detail.periode,
        reference: detail.reference ? "disponible" : "indisponible",
        statutRealise: (detail.statutRealise as Row).statut,
        encaissements: c && { ...(c.encaissements as Row), precision: p((c.encaissements as Row).precision) },
        decaissements: c && { ...(c.decaissements as Row), precision: p((c.decaissements as Row).precision) },
        cashNet: c?.cashNet,
        globale: c && { ...(c.globale as Row), valeur: p(c.globale) },
        groupes: c && (c.groupes as Row[]).map((g) => `${g.libelle}: ${g.prevu} -> ${g.realise} (${g.ecart})`),
        revisions: (detail.revisions as Row[]).map((r) => r.revision),
        realise: { nombreTransactions: (detail.realise as Row).nombreTransactions, lignes: ((detail.realise as Row).lignes as Row[]).map((l) => `${l.date} ${l.montant} ${l.groupe}`) },
        points: (data.points as Row[]).map((pt) => `${(pt.periode as Row).debut} ref=${pt.referenceDisponible} realise=${pt.statutRealise} publiable=${pt.publiable} global=${p(pt.globale)}`),
      },
      null,
      2
    )
  );
}

lancer(async () => {
  const admin = adminStaging();
  const companyId = await societeTest(admin);
  const args = process.argv.slice(2);
  const valeur = (option: string, rang = 1) => args[args.indexOf(option) + rang];
  if (args.includes("--scenarios")) return scenarios(admin, companyId);
  if (args.includes("--nettoyer")) return nettoyer(companyId);
  if (args.includes("--module")) {
    // Bascule du module Passé de la société de test (parcours « Futur seul » / « Passé + Futur »).
    const actif = valeur("--module") === "on";
    const { error } = await admin.from("organization_modules").upsert({ organization_id: companyId, module_key: "past", enabled: actif }, { onConflict: "organization_id,module_key" });
    if (error) throw error;
    console.log(`Module Passé ${actif ? "activé" : "désactivé"}.`);
    return;
  }
  if (args.includes("--droits")) {
    const jeton = await jetonTest(admin);
    const utilisateur = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY!, {
      auth: { persistSession: false },
      global: { headers: { Authorization: `Bearer ${jeton}` } },
    });
    const lire = async (table: string, colonne: string) => {
      const { data, error } = await utilisateur.from(table).select(colonne);
      if (error) return `refus (${error.code})`;
      const societes = new Set(((data ?? []) as unknown as Row[]).map((r) => r[colonne]));
      return `${(data ?? []).length} ligne(s), société(s) : ${[...societes].map((x) => (x === companyId ? "la sienne" : "AUTRE")).join(", ") || "aucune"}`;
    };
    const ecrire = await utilisateur.from("future_forecast_references").insert({
      company_id: companyId, period_kind: "month", period_start: "2027-01-01", period_end: "2027-01-31", reference_at: new Date().toISOString(),
      captured_at: new Date().toISOString(), status: "official", capture_mode: "before_close", engine_version: 1, totals: {}, lines: [], coverage: {},
    });
    const { count: total } = await admin.from("future_forecast_references").select("*", { count: "exact", head: true });
    console.log(JSON.stringify({
      references: await lire("future_forecast_references", "company_id"),
      referencesToutesSocietes: total,
      resultats: await lire("future_accuracy_results", "company_id"),
      synchronisations: await lire("past_sync_runs", "organization_id"),
      evenements: await lire("future_change_events", "company_id"),
      insertionReferenceParUtilisateur: ecrire.error ? `refus (${ecrire.error.code})` : "ACCEPTÉE (anomalie)",
    }, null, 2));
    return;
  }
  if (args.includes("--modifier-officielle")) {
    // Doit échouer : une référence officielle est figée (trigger), même pour la clé service_role.
    const maj = await admin.from("future_forecast_references").update({ totals: {} }).eq("company_id", companyId).eq("status", "official").eq("period_start", "2026-08-01");
    const sup = await admin.from("future_forecast_references").delete().eq("company_id", companyId).eq("status", "official").eq("period_start", "2026-08-01");
    console.log("modification :", maj.error?.message ?? "ACCEPTÉE (anomalie)", "| suppression :", sup.error?.message ?? "ACCEPTÉE (anomalie)");
    return;
  }
  if (args.includes("--relire")) {
    const { chargerPastTransactions } = await import("../../lib/pastTransactionsRepository");
    const toutes = await chargerPastTransactions(admin, companyId, { debut: "2025-10-01", fin: "2026-09-30" });
    console.log(toutes.length, toutes.filter((t) => t.transactionDate.startsWith("2026-08")).map((t) => `${t.transactionDate} ${t.amount}`));
    return;
  }
  if (args.includes("--inspecter")) {
    const { data, error } = await admin
      .from("past_transactions")
      .select("transaction_date, amount, source_transaction_id, past_transaction_categories(analytic_group_id, analytic_category_name)")
      .eq("organization_id", companyId)
      .gte("transaction_date", "2026-08-01")
      .lte("transaction_date", "2026-08-31");
    if (error) throw error;
    console.log(JSON.stringify(data, null, 1));
    return;
  }
  if (args.includes("--transaction-tardive")) {
    // Transaction d'août arrivée après coup (synchronisation ultérieure) : corrige le réalisé.
    const { data, error } = await admin
      .from("past_transactions")
      .upsert(
        { organization_id: companyId, source_type: "pennylane", source_transaction_id: `${SOURCE_TEST}tardive`, transaction_date: "2026-08-28", label: `${PREFIXE} Achat tardif`, amount: -3000, currency: "EUR" },
        { onConflict: "organization_id,source_type,source_transaction_id" }
      )
      .select("id")
      .single();
    if (error) throw error;
    await admin.from("past_transaction_categories").delete().eq("transaction_id", (data as Row).id);
    const { error: e2 } = await admin.from("past_transaction_categories").insert({
      organization_id: companyId, transaction_id: (data as Row).id, analytic_group_id: AXE_TEST,
      analytic_category_id: `${SOURCE_TEST}Achats`, analytic_category_name: "Achats", weight: 1,
    });
    if (e2) throw e2;
    console.log("Transaction tardive ajoutée au 28 août (−3 000 €, Achats).");
    return;
  }
  if (args.includes("--api")) return api(admin, valeur("--api"), valeur("--api", 2) ?? "month", valeur("--api", 3));
  if (args.includes("--capture")) {
    const instant = new Date(valeur("--capture"));
    if (Number.isNaN(instant.getTime())) throw new RefusGardeFou("Instant invalide (ISO 8601 attendu).");
    console.log(`Capture simulée à ${instant.toISOString()} :`, await capturerSociete(admin, companyId, instant));
    return;
  }
  return etat(admin, companyId);
});
