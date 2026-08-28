/**
 * Parsing déterministe des montants bancaires. Priorité 1 : si la cellule Excel contient déjà
 * une vraie valeur numérique, on l'utilise telle quelle (pas de parsing de son rendu visuel).
 * Priorité 2 : parsing texte tolérant (espaces, espaces insécables, symbole monétaire, virgule
 * ou point décimal, séparateurs de milliers, parenthèses comptables).
 *
 * Quand un format à séparateur unique est intrinsèquement ambigu au niveau d'une seule cellule
 * (ex: "1,200"), on ne devine jamais cellule par cellule : `analyserMontantCellule` retourne
 * `ambigu: true` et c'est `resoudreColonneMontants` qui tranche à partir de la cohérence de la
 * colonne entière (voir bankXlsxAdapter.ts).
 */

export interface AnalyseMontant {
  ok: boolean;
  valeur: number | null;
  ambigu: boolean; // ok=false && ambigu=true => nécessite le contexte de la colonne entière
  convention: "," | "." | null; // convention décimale déduite sans ambiguïté par cette cellule seule
}

// \s couvre déjà l'espace normal, l'espace insécable (U+00A0) et l'espace fine insécable
// (U+202F, catégorie Unicode Zs) utilisés dans les montants formatés à la française.
const ESPACES = /\s/g;

function normaliserTexteMontant(texte: string): { corps: string; negatif: boolean } {
  let t = texte.trim();
  let negatif = false;
  if (t.startsWith("(") && t.endsWith(")")) {
    negatif = true;
    t = t.slice(1, -1);
  }
  t = t.replace(ESPACES, "").replace(/€/g, "");
  if (t.startsWith("+")) {
    t = t.slice(1);
  } else if (t.startsWith("-")) {
    negatif = true;
    t = t.slice(1);
  }
  return { corps: t, negatif };
}

const INVALIDE: AnalyseMontant = { ok: false, valeur: null, ambigu: false, convention: null };
const AMBIGU: AnalyseMontant = { ok: false, valeur: null, ambigu: true, convention: null };

export function analyserMontantCellule(valeurCellule: unknown): AnalyseMontant {
  if (typeof valeurCellule === "number") {
    return Number.isFinite(valeurCellule) ? { ok: true, valeur: valeurCellule, ambigu: false, convention: null } : INVALIDE;
  }

  const brut = String(valeurCellule ?? "").trim();
  if (!brut) return INVALIDE;

  const { corps, negatif } = normaliserTexteMontant(brut);
  if (!corps) return INVALIDE;

  const iVirgule = corps.lastIndexOf(",");
  const iPoint = corps.lastIndexOf(".");
  const nbVirgules = corps.split(",").length - 1;
  const nbPoints = corps.split(".").length - 1;

  let corpsNumerique: string;
  let convention: "," | "." | null = null;

  if (iVirgule !== -1 && iPoint !== -1) {
    // Les deux séparateurs sont présents : celui qui apparaît en dernier est la décimale
    // (structure du nombre) — ex: "1.200,92" → virgule décimale ; "1,200.92" → point décimal.
    if (iVirgule > iPoint) {
      corpsNumerique = corps.replace(/\./g, "").replace(",", ".");
      convention = ",";
    } else {
      corpsNumerique = corps.replace(/,/g, "");
      convention = ".";
    }
  } else if (iVirgule !== -1) {
    if (nbVirgules > 1) {
      corpsNumerique = corps.replace(/,/g, ""); // regroupement de milliers répété, pas de décimale
    } else {
      const apresVirgule = corps.length - iVirgule - 1;
      if (apresVirgule === 1 || apresVirgule === 2) {
        corpsNumerique = corps.replace(",", ".");
        convention = ",";
      } else if (apresVirgule === 0) {
        corpsNumerique = corps.replace(",", "");
      } else if (apresVirgule === 3) {
        return AMBIGU; // ex: "1,200" — ne peut être tranché qu'au niveau de la colonne
      } else {
        return INVALIDE;
      }
    }
  } else if (iPoint !== -1) {
    if (nbPoints > 1) {
      corpsNumerique = corps.replace(/\./g, "");
    } else {
      const apresPoint = corps.length - iPoint - 1;
      if (apresPoint === 1 || apresPoint === 2) {
        corpsNumerique = corps;
        convention = ".";
      } else if (apresPoint === 0) {
        corpsNumerique = corps.replace(".", "");
      } else if (apresPoint === 3) {
        return AMBIGU;
      } else {
        return INVALIDE;
      }
    }
  } else {
    corpsNumerique = corps;
  }

  const nombre = Number(corpsNumerique);
  if (!Number.isFinite(nombre)) return INVALIDE;
  return { ok: true, valeur: negatif ? -Math.abs(nombre) : nombre, ambigu: false, convention };
}

/** Résout une cellule marquée `ambigu` une fois la convention décimale de sa colonne connue. */
export function resoudreMontantAmbigu(valeurCellule: unknown, conventionColonne: "," | "."): number | null {
  const brut = String(valeurCellule ?? "").trim();
  if (!brut) return null;
  const { corps, negatif } = normaliserTexteMontant(brut);
  const separateur = corps.includes(",") ? "," : corps.includes(".") ? "." : null;
  if (!separateur) return null;

  const corpsNumerique =
    separateur === conventionColonne
      ? corps.replace(separateur, ".")
      : corps.replace(new RegExp(`\\${separateur}`, "g"), "");

  const nombre = Number(corpsNumerique);
  if (!Number.isFinite(nombre)) return null;
  return negatif ? -Math.abs(nombre) : nombre;
}

export interface ResolutionColonneMontant {
  ok: boolean; // false = colonne globalement ambiguë (aucune convention décidable), à bloquer
  valeurs: (number | null)[]; // même longueur/ordre que l'entrée ; null = cellule illisible
}

/**
 * Résout une colonne entière de montants. Détermine la convention décimale de la colonne à partir
 * des cellules non ambiguës (vote), puis l'applique aux cellules ambiguës isolément indécidables.
 * Si aucune convention ne peut être établie alors que des cellules ambiguës existent, la colonne
 * est déclarée globalement ambiguë (`ok: false`) — jamais d'inversion silencieuse.
 */
export function resoudreColonneMontants(valeursCellule: unknown[]): ResolutionColonneMontant {
  const analyses = valeursCellule.map(analyserMontantCellule);

  const votes: Record<"," | ".", number> = { ",": 0, ".": 0 };
  for (const a of analyses) {
    if (a.convention) votes[a.convention]++;
  }

  let conventionColonne: "," | "." | null = null;
  if (votes[","] > 0 && votes["."] === 0) conventionColonne = ",";
  else if (votes["."] > 0 && votes[","] === 0) conventionColonne = ".";
  else if (votes[","] > 0 && votes["."] > 0) conventionColonne = votes[","] >= votes["."] ? "," : ".";

  const aDesCellulesAmbigues = analyses.some((a) => a.ambigu);
  if (aDesCellulesAmbigues && conventionColonne === null) {
    return { ok: false, valeurs: [] };
  }

  const valeurs = analyses.map((a, i) => {
    if (a.ok) return a.valeur;
    if (a.ambigu && conventionColonne) return resoudreMontantAmbigu(valeursCellule[i], conventionColonne);
    return null;
  });

  return { ok: true, valeurs };
}
