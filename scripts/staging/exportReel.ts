/**
 * Import d'un export RÉEL (scripts/staging/export-qannt.sql) vers le staging — transformation pure,
 * sans accès à la base ni au disque.
 *
 * Principe : les données métier sont conservées TELLES QUELLES. Noms de clients et de
 * fournisseurs, libellés, numéros de factures, montants, dates et statuts ne sont jamais modifiés :
 * un test sur le staging doit porter sur les mêmes données que la société d'origine.
 *
 * Seules des transformations TECHNIQUES sont appliquées, nécessaires pour que les lignes
 * appartiennent à la société staging sans rien partager avec la base d'origine :
 *  - id : un nouvel UUID par ligne (aucun identifiant de la base d'origine n'est réutilisé) ;
 *  - fixed_charges.source_calcul_id : réécrit vers le nouvel id de la ligne source ;
 *  - company_id : retiré (remplacé par celui de la société staging à l'insertion) ;
 *  - updated_at : retiré (horodatage technique, reposé par la base).
 *
 * Aucune anonymisation ici. Le jeu SYNTHÉTIQUE (fixtures.ts) est un mode distinct, entièrement
 * fabriqué, qui ne passe jamais par ce module.
 */
import { randomUUID } from "node:crypto";

export type Ligne = Record<string, unknown>;

export const TABLES_DONNEES = [
  "fixed_charges",
  "recurring_income",
  "supplier_invoices",
  "customer_invoices",
  "other_expenses",
  "financings",
] as const;
export type TableDonnees = (typeof TABLES_DONNEES)[number];

export type Jeu = { cash_settings: Ligne | null } & Record<TableDonnees, Ligne[]>;

export class ExportInvalide extends Error {}

/**
 * Lit le résultat de scripts/staging/export-qannt.sql. Accepte l'objet lui-même, ou la forme sous
 * laquelle l'éditeur SQL Supabase le restitue : une ligne { "export": {...} }, seule ou dans un
 * tableau, l'objet pouvant y être sérialisé en chaîne.
 */
export function lireExport(contenu: string): Jeu {
  let valeur: unknown = JSON.parse(contenu);
  for (let i = 0; i < 4; i++) {
    if (typeof valeur === "string") valeur = JSON.parse(valeur);
    else if (Array.isArray(valeur) && valeur.length === 1) valeur = valeur[0];
    else if (valeur && typeof valeur === "object" && "export" in valeur) valeur = (valeur as { export: unknown }).export;
    else break;
  }
  if (!valeur || typeof valeur !== "object" || Array.isArray(valeur)) {
    throw new ExportInvalide("Fichier d'export illisible : objet JSON attendu (résultat de scripts/staging/export-qannt.sql).");
  }
  const brut = valeur as Record<string, unknown>;
  const manquantes: string[] = TABLES_DONNEES.filter((table) => !Array.isArray(brut[table]));
  if (!("cash_settings" in brut)) manquantes.push("cash_settings");
  if (manquantes.length > 0) throw new ExportInvalide(`Fichier d'export incomplet : ${manquantes.join(", ")} absent(s).`);
  for (const table of TABLES_DONNEES) {
    const sansId = (brut[table] as Ligne[]).filter((ligne) => !ligne || typeof ligne.id !== "string").length;
    if (sansId > 0) throw new ExportInvalide(`Fichier d'export invalide : ${sansId} ligne(s) sans id dans ${table}.`);
  }
  return brut as Jeu;
}

/** Colonnes propres à la base d'origine, jamais reprises. */
const COLONNES_TECHNIQUES = ["company_id", "updated_at"] as const;

function sansColonnesTechniques(ligne: Ligne): Ligne {
  const copie = { ...ligne };
  for (const colonne of COLONNES_TECHNIQUES) delete copie[colonne];
  return copie;
}

/**
 * Prépare un export réel pour l'insertion dans la société staging : transformations techniques
 * uniquement (voir l'en-tête du fichier). `nouvelUuid` est injectable pour les tests.
 */
export function preparerExportReel(exportReel: Jeu, nouvelUuid: () => string = randomUUID): Jeu {
  const nouveauxIds = new Map<string, string>();
  const nouvelId = (ancien: unknown): string => {
    const cle = String(ancien);
    if (!nouveauxIds.has(cle)) nouveauxIds.set(cle, nouvelUuid());
    return nouveauxIds.get(cle) as string;
  };
  const reidentifier = (ligne: Ligne): Ligne => ({ ...sansColonnesTechniques(ligne), id: nouvelId(ligne.id) });

  // Les deux tables pouvant servir de source à une charge calculée sont réidentifiées avant de
  // réécrire source_calcul_id : la référence suit ainsi le nouvel id de sa source.
  const rentrees = exportReel.recurring_income.map(reidentifier);
  const charges = exportReel.fixed_charges
    .map(reidentifier)
    .map((charge) => (charge.source_calcul_id ? { ...charge, source_calcul_id: nouvelId(charge.source_calcul_id) } : charge));

  return {
    cash_settings: exportReel.cash_settings ? sansColonnesTechniques(exportReel.cash_settings) : null,
    fixed_charges: charges,
    recurring_income: rentrees,
    supplier_invoices: exportReel.supplier_invoices.map(reidentifier),
    customer_invoices: exportReel.customer_invoices.map(reidentifier),
    other_expenses: exportReel.other_expenses.map(reidentifier),
    financings: exportReel.financings.map(reidentifier),
  };
}
