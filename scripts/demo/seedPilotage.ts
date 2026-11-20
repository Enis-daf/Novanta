/**
 * Jeu de démonstration « Perspectives pondérées » sur UNE société vérifiée (offre Pilotage).
 *
 *   node --import tsx scripts/demo/seedPilotage.ts <commande> [--j0 AAAA-MM-JJ] [--ecrire]
 *
 * Sans --ecrire : simulation (rien n'est écrit, la liste des écritures est affichée).
 *
 * Commandes :
 *   installer      met de côté les lignes Futur existantes (inventaire), écrit le jeu à l'état
 *                  initial (3 hypothèses à renseigner, sans financement d'anticipation) ;
 *   etat-initial   remet le jeu à l'état initial (ne touche pas aux lignes mises de côté) ;
 *   renseigner     enregistre les trois hypothèses pédagogiques comme dans le guide ;
 *   financement    ajoute le financement confirmé de 30 000 € à J8 (étape « agir avant ») ;
 *   a-en-retard    date d'encaissement de A passée (vérification des factures en retard) ;
 *   reancrer       réécrit le jeu à l'état initial avec un nouveau J0 (--j0, défaut : aujourd'hui) ;
 *   retirer        supprime les seules lignes du jeu et rétablit l'existant depuis l'inventaire.
 *
 * Garde-fous : société imposée (SOCIETE ci-dessous) et revérifiée (nom, offre) avant toute
 * écriture ; toute requête filtrée sur cette société ; lignes du jeu repérées par identifiants
 * déterministes (jeuPilotage.ts::uuidDemo) ; écritures en upsert (réexécution sans doublon).
 * Aucune donnée n'est envoyée à Pennylane ni à un autre service.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { clientAdmin } from "./connexion";
import { jeuPilotage, JeuDemo, OptionsJeu, PREFIXE, uuidDemo } from "./jeuPilotage";
import {
  autreDepenseToRow,
  chargeFixeToRow,
  factureClientToRow,
  factureFournisseurToRow,
  facturePrevisionnelleToRow,
  financementToRow,
  rentreeReguliereToRow,
} from "../../lib/supabaseRepository";
import { enregistrerHypothese } from "../../lib/probaRepository";
import { decalerDateISO } from "../../lib/dates";
import { dateDansFuseau } from "../../lib/fiabiliteProjection";

export const SOCIETE = "9d5170e6-019f-41ae-9782-c86085cb59cd";
const NOM_ATTENDU = "Compte démo";
const FICHIER_INVENTAIRE = join(__dirname, "inventaires", `${SOCIETE}.json`);

type Row = Record<string, unknown>;
interface Inventaire {
  societe: string;
  creeLe: string;
  reglages: { solde_initial: number; date_releve: string; horizon_jours: number } | null;
  // Valeurs d'origine des seules colonnes modifiées pour mettre la ligne de côté.
  misesDeCote: Record<string, { id: string; avant: Row }[]>;
  jeu: { j0: string; etat: string; ecritLe: string } | null;
}

// Mise de côté : table -> (ligne active ?, colonnes à écrire pour l'écarter).
const MISE_DE_COTE: Record<string, { active: (r: Row, j0: string) => boolean; ecarter: (j0: string) => Row; colonnes: string[] }> = {
  customer_invoices: { active: (r) => !r.paid, ecarter: (j0) => ({ paid: true, paid_at: `${decalerDateISO(j0, -8)}T00:00:00.000Z` }), colonnes: ["paid", "paid_at"] },
  supplier_invoices: { active: (r) => !r.paid, ecarter: (j0) => ({ paid: true, paid_at: `${decalerDateISO(j0, -8)}T00:00:00.000Z` }), colonnes: ["paid", "paid_at"] },
  fixed_charges: { active: (r) => !r.a_couper, ecarter: () => ({ a_couper: true }), colonnes: ["a_couper"] },
  other_expenses: { active: (r) => !r.payee && !r.facturee, ecarter: () => ({ payee: true }), colonnes: ["payee"] },
  financings: { active: (r) => !r.verse, ecarter: () => ({ verse: true }), colonnes: ["verse"] },
  recurring_income: { active: (r, j0) => !r.date_fin || String(r.date_fin) >= j0, ecarter: (j0) => ({ date_fin: decalerDateISO(j0, -1) }), colonnes: ["date_fin"] },
};

function idsDuJeu(): Set<string> {
  const ids = new Set<string>();
  for (const options of [{}, { financementAnticipation: true }] as OptionsJeu[]) {
    const jeu = jeuPilotage(SOCIETE, "2000-01-01", options);
    for (const liste of [jeu.facturesClients, jeu.facturesFournisseurs, jeu.chargesFixes, jeu.autresDepenses, jeu.financements, jeu.rentreesRegulieres, jeu.facturesPrevisionnelles]) {
      for (const l of liste) ids.add(l.id);
    }
  }
  return ids;
}

function lireInventaire(): Inventaire | null {
  return existsSync(FICHIER_INVENTAIRE) ? (JSON.parse(readFileSync(FICHIER_INVENTAIRE, "utf8")) as Inventaire) : null;
}
function ecrireInventaire(inv: Inventaire) {
  mkdirSync(join(__dirname, "inventaires"), { recursive: true });
  writeFileSync(FICHIER_INVENTAIRE, JSON.stringify(inv, null, 2) + "\n");
}

async function main() {
  const commande = process.argv[2];
  const ecrire = process.argv.includes("--ecrire");
  const j0Arg = process.argv.includes("--j0") ? process.argv[process.argv.indexOf("--j0") + 1] : null;
  const { admin, ref } = clientAdmin();
  const journal: string[] = [];
  const action = async (description: string, effet: () => PromiseLike<{ error: unknown } | void> | Promise<void>) => {
    journal.push(description);
    if (!ecrire) return;
    const r = await effet();
    if (r && "error" in r && r.error) throw new Error(`${description} : ${JSON.stringify(r.error)}`);
  };

  // --- Garde-fou : la société visée est bien le compte démo, en offre Pilotage ---
  const { data: societe, error } = await admin.from("companies").select("id, name, plan, plan_override, access_enabled").eq("id", SOCIETE).maybeSingle();
  if (error || !societe) throw new Error("Société de démonstration introuvable.");
  if (societe.name !== NOM_ATTENDU) throw new Error(`Société inattendue (« ${societe.name} ») : arrêt.`);
  if ((societe.plan_override ?? societe.plan) !== "steering" || societe.access_enabled !== true) throw new Error("La société n'est pas en offre Pilotage : arrêt.");
  console.log(`Projet ${ref} · société ${SOCIETE} (« ${societe.name} », Pilotage) · ${ecrire ? "ÉCRITURE" : "simulation, rien n'est écrit"}`);

  const inventaire = lireInventaire();
  const idsJeu = idsDuJeu();
  const aujourdhui = dateDansFuseau(new Date());

  /** Écrit (upsert) le jeu dans l'état demandé, et retire ses lignes qui n'en font pas partie. */
  const ecrireJeu = async (jeu: JeuDemo, etat: string) => {
    const upsert = (table: string, rows: Row[]) =>
      action(`upsert ${table} (${rows.length})`, () => admin.from(table).upsert(rows, { onConflict: "id" }));
    await action(`cash_settings : solde ${jeu.soldeInitial}, relevé ${jeu.j0}, horizon ${jeu.horizonJours}`, () =>
      admin.from("cash_settings").upsert({ company_id: SOCIETE, solde_initial: jeu.soldeInitial, date_releve: jeu.j0, horizon_jours: jeu.horizonJours }, { onConflict: "company_id" })
    );
    await upsert(
      "customer_invoices",
      jeu.facturesClients.map((f) => ({ ...factureClientToRow(SOCIETE, f), settled_on: f.settledOn ?? null }))
    );
    await upsert("supplier_invoices", jeu.facturesFournisseurs.map((f) => factureFournisseurToRow(SOCIETE, f)));
    await upsert("fixed_charges", jeu.chargesFixes.map((c) => chargeFixeToRow(SOCIETE, c)));
    await upsert("other_expenses", jeu.autresDepenses.map((d) => autreDepenseToRow(SOCIETE, d)));
    await upsert("financings", jeu.financements.map((f) => financementToRow(SOCIETE, f)));
    await upsert("recurring_income", jeu.rentreesRegulieres.map((r) => rentreeReguliereToRow(SOCIETE, r)));
    await upsert("forecast_customer_invoices", jeu.facturesPrevisionnelles.map((p) => facturePrevisionnelleToRow(SOCIETE, p)));
    // Lignes du jeu absentes de cet état (ex. financement d'anticipation) : supprimées.
    const presents = new Set([...jeu.financements].map((f) => f.id));
    for (const id of [uuidDemo(SOCIETE, "FI-anticipation")].filter((x) => !presents.has(x))) {
      await action(`suppression financings ${id} (hors de l'état « ${etat} »)`, () => admin.from("financings").delete().eq("company_id", SOCIETE).eq("id", id));
    }
    // Hypothèses : celles de l'état, et rien d'autre parmi les lignes du jeu.
    const voulues = new Set(jeu.hypotheses.map((h) => `${h.source}:${h.sourceId}`));
    const { data: existantes } = await admin.from("forecast_event_assumptions").select("source_type, source_id").eq("company_id", SOCIETE);
    for (const h of (existantes ?? []) as Row[]) {
      const cle = `${h.source_type}:${h.source_id}`;
      if (idsJeu.has(String(h.source_id)) && !voulues.has(cle)) {
        await action(`suppression hypothèse ${cle}`, () =>
          admin.from("forecast_event_assumptions").delete().eq("company_id", SOCIETE).eq("source_type", String(h.source_type)).eq("source_id", String(h.source_id))
        );
      }
    }
    for (const h of jeu.hypotheses) await action(`hypothèse ${h.source}:${h.sourceId}`, () => enregistrerHypothese(admin, SOCIETE, h));
    if (ecrire) ecrireInventaire({ ...(lireInventaire() as Inventaire), jeu: { j0: jeu.j0, etat, ecritLe: new Date().toISOString() } });
  };

  /** Met de côté les lignes Futur actives qui n'appartiennent pas au jeu (une seule fois par ligne). */
  const mettreDeCote = async (j0: string) => {
    const inv: Inventaire = inventaire ?? { societe: SOCIETE, creeLe: new Date().toISOString(), reglages: null, misesDeCote: {}, jeu: null };
    if (!inv.reglages) {
      const { data } = await admin.from("cash_settings").select("solde_initial, date_releve, horizon_jours").eq("company_id", SOCIETE).maybeSingle();
      inv.reglages = data ? { solde_initial: Number(data.solde_initial), date_releve: String(data.date_releve), horizon_jours: Number(data.horizon_jours) } : null;
    }
    for (const [table, regle] of Object.entries(MISE_DE_COTE)) {
      const { data, error: e } = await admin.from(table).select(["id", ...regle.colonnes, ...(table.endsWith("invoices") ? ["facture"] : ["libelle"])].join(", ")).eq("company_id", SOCIETE);
      if (e) throw e;
      const deja = new Set((inv.misesDeCote[table] ?? []).map((x) => x.id));
      for (const r of (data ?? []) as unknown as Row[]) {
        const id = String(r.id);
        const libelle = String(r.facture ?? r.libelle ?? "");
        if (idsJeu.has(id) || libelle.startsWith(PREFIXE) || deja.has(id) || !regle.active(r, j0)) continue;
        const avant = Object.fromEntries(regle.colonnes.map((c) => [c, r[c] ?? null]));
        (inv.misesDeCote[table] ??= []).push({ id, avant });
        await action(`mise de côté ${table} ${id} (${libelle}) : ${JSON.stringify(regle.ecarter(j0))}`, () =>
          admin.from(table).update(regle.ecarter(j0)).eq("company_id", SOCIETE).eq("id", id)
        );
      }
    }
    // Factures prévisionnelles existantes non rapprochées : aucune colonne d'exclusion, signalées.
    const { data: prev } = await admin.from("forecast_customer_invoices").select("id").eq("company_id", SOCIETE);
    const etrangeres = ((prev ?? []) as Row[]).filter((p) => !idsJeu.has(String(p.id)));
    if (etrangeres.length > 0) console.warn(`ATTENTION : ${etrangeres.length} facture(s) prévisionnelle(s) existante(s) non mises de côté.`);
    if (ecrire) ecrireInventaire(inv);
  };

  const j0 = j0Arg ?? inventaire?.jeu?.j0 ?? aujourdhui;
  switch (commande) {
    case "installer":
      await mettreDeCote(j0Arg ?? aujourdhui);
      await ecrireJeu(jeuPilotage(SOCIETE, j0Arg ?? aujourdhui), "initial");
      break;
    case "etat-initial":
      await ecrireJeu(jeuPilotage(SOCIETE, j0), "initial");
      break;
    case "renseigner":
      await ecrireJeu(jeuPilotage(SOCIETE, j0, { hypothesesRenseignees: true }), "hypothèses renseignées");
      break;
    case "financement":
      await ecrireJeu(jeuPilotage(SOCIETE, j0, { hypothesesRenseignees: true, financementAnticipation: true }), "financement d'anticipation");
      break;
    case "a-en-retard":
      await ecrireJeu(jeuPilotage(SOCIETE, j0, { factureAEnRetard: "date_passee" }), "A en retard");
      break;
    case "reancrer":
      await ecrireJeu(jeuPilotage(SOCIETE, j0Arg ?? aujourdhui), "initial");
      break;
    case "retirer": {
      if (!inventaire) throw new Error("Aucun inventaire : rien à rétablir.");
      for (const table of ["customer_invoices", "supplier_invoices", "fixed_charges", "other_expenses", "financings", "recurring_income", "forecast_customer_invoices"]) {
        for (const id of idsJeu) await action(`suppression ${table} ${id}`, () => admin.from(table).delete().eq("company_id", SOCIETE).eq("id", id));
      }
      for (const id of idsJeu) await action(`suppression hypothèses de ${id}`, () => admin.from("forecast_event_assumptions").delete().eq("company_id", SOCIETE).eq("source_id", id));
      for (const [table, lignes] of Object.entries(inventaire.misesDeCote)) {
        for (const { id, avant } of lignes) await action(`rétablissement ${table} ${id}`, () => admin.from(table).update(avant).eq("company_id", SOCIETE).eq("id", id));
      }
      if (inventaire.reglages) {
        const reglages = inventaire.reglages;
        await action(`cash_settings rétabli`, () => admin.from("cash_settings").update(reglages).eq("company_id", SOCIETE));
      }
      if (ecrire) ecrireInventaire({ ...inventaire, misesDeCote: {}, reglages: null, jeu: null });
      break;
    }
    default:
      throw new Error(`Commande inconnue : ${commande}`);
  }
  console.log(journal.map((l) => `  ${l}`).join("\n"));
  console.log(`${journal.length} opération(s) ${ecrire ? "exécutée(s)" : "simulée(s)"}.`);
}

if (require.main === module) main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
