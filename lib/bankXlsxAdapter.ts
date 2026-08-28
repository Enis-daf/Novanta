import * as XLSX from "xlsx";
import { NormalizedBankTransaction, normaliserLibelleBancaire } from "./bankTransaction";
import { analyserDateBancaire } from "./bankDate";
import { resoudreColonneMontants } from "./bankMontant";

/**
 * XlsxBankTransactionAdapter : convertit un relevé bancaire .xlsx en NormalizedBankTransaction[].
 * C'est la SEULE partie de ce module qui connaît le format Excel — le moteur de détection
 * (bankRecurringDetector.ts) et l'écran de validation n'en dépendent jamais directement. Une
 * future source Pennylane fournirait le même NormalizedBankTransaction[] via son propre adaptateur,
 * sans toucher au reste.
 *
 * Aucun mapping manuel de colonnes n'est demandé à l'utilisateur : la ligne d'en-tête et le rôle
 * de chaque colonne sont déduits automatiquement (voir ALIAS_* ci-dessous). Un fichier globalement
 * non interprétable est bloqué avec un diagnostic actionnable (ErreurImportBancaire) ; un fichier
 * interprétable avec quelques lignes illisibles continue, ces lignes étant simplement ignorées.
 */

export interface StatutColonne {
  ok: boolean;
  detail: string; // si ok: le nom de colonne détecté ; sinon: un message actionnable pour l'utilisateur
}

export interface DiagnosticColonnes {
  totalLignes: number;
  date: StatutColonne;
  libelle: StatutColonne;
  montant: StatutColonne;
}

export class ErreurImportBancaire extends Error {
  diagnostic?: DiagnosticColonnes;
  constructor(message: string, diagnostic?: DiagnosticColonnes) {
    super(message);
    this.name = "ErreurImportBancaire";
    this.diagnostic = diagnostic;
  }
}

export interface ResultatAnalyseBancaire {
  transactions: NormalizedBankTransaction[];
  totalLignesAnalysees: number; // lignes de données non vides sous l'en-tête
  lignesIgnorees: number;
  raisonsIgnorees: string[]; // messages agrégés et lisibles, ex: "3 ligne(s) ignorée(s) car..."
  periode: { debut: string; fin: string } | null;
  colonneDate: string;
  colonneLibelle: string;
}

const TAILLE_MAX_OCTETS = 5 * 1024 * 1024; // 5 Mo
const LIGNES_MAX = 20000;
const FENETRE_RECHERCHE_ENTETE = 20; // nombre de lignes scannées pour trouver l'en-tête
const SEUIL_ECHEC_GLOBAL = 0.5; // >50% d'échec sur une colonne clé = format non reconnu (pas juste quelques lignes)

function normaliserEnteteColonne(texte: string): string {
  return texte
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

const ALIAS_DATE = new Set([
  "date",
  "date transaction",
  "date de transaction",
  "date operation",
  "date d operation",
  "date valeur",
]);

const ALIAS_LIBELLE = new Set(["libelle", "description", "operation", "detail", "intitule"]);
const ALIAS_MONTANT = new Set(["montant", "amount"]);
const ALIAS_DEBIT = new Set(["debit", "montant debit"]);
const ALIAS_CREDIT = new Set(["credit", "montant credit"]);

interface EntetePotentielle {
  ligneIndex: number;
  colDate: number | null;
  colDateTexte: string | null;
  colLibelle: number | null;
  colLibelleTexte: string | null;
  colMontant: number | null;
  colMontantTexte: string | null;
  colDebit: number | null;
  colDebitTexte: string | null;
  colCredit: number | null;
  colCreditTexte: string | null;
}

function enteteVide(ligneIndex: number): EntetePotentielle {
  return {
    ligneIndex,
    colDate: null,
    colDateTexte: null,
    colLibelle: null,
    colLibelleTexte: null,
    colMontant: null,
    colMontantTexte: null,
    colDebit: null,
    colDebitTexte: null,
    colCredit: null,
    colCreditTexte: null,
  };
}

function analyserLigneEntete(ligne: unknown[], index: number): EntetePotentielle {
  const entete = enteteVide(index);
  ligne.forEach((cellule, colonne) => {
    const texteOriginal = String(cellule ?? "").trim();
    const norm = normaliserEnteteColonne(texteOriginal);
    if (!norm) return;
    if (entete.colDate === null && ALIAS_DATE.has(norm)) {
      entete.colDate = colonne;
      entete.colDateTexte = texteOriginal;
      return;
    }
    if (entete.colLibelle === null && ALIAS_LIBELLE.has(norm)) {
      entete.colLibelle = colonne;
      entete.colLibelleTexte = texteOriginal;
      return;
    }
    if (entete.colMontant === null && ALIAS_MONTANT.has(norm)) {
      entete.colMontant = colonne;
      entete.colMontantTexte = texteOriginal;
      return;
    }
    if (entete.colDebit === null && ALIAS_DEBIT.has(norm)) {
      entete.colDebit = colonne;
      entete.colDebitTexte = texteOriginal;
      return;
    }
    if (entete.colCredit === null && ALIAS_CREDIT.has(norm)) {
      entete.colCredit = colonne;
      entete.colCreditTexte = texteOriginal;
    }
  });
  return entete;
}

/** Un en-tête valide identifie date + libellé + exactement UNE interprétation du montant (jamais les deux à la fois). */
function enteteValideEtNonContradictoire(e: EntetePotentielle): boolean {
  const montantSeul = e.colMontant !== null;
  const debitCredit = e.colDebit !== null && e.colCredit !== null;
  const contradictoire = montantSeul && (e.colDebit !== null || e.colCredit !== null);
  return e.colDate !== null && e.colLibelle !== null && (montantSeul || debitCredit) && !contradictoire;
}

function scoreEntete(e: EntetePotentielle): number {
  return (
    (e.colDate !== null ? 1 : 0) +
    (e.colLibelle !== null ? 1 : 0) +
    (e.colMontant !== null || e.colDebit !== null || e.colCredit !== null ? 1 : 0)
  );
}

function construireDiagnostic(e: EntetePotentielle, totalLignes: number): DiagnosticColonnes {
  const montantSeul = e.colMontant !== null;
  const debitOk = e.colDebit !== null;
  const creditOk = e.colCredit !== null;
  const contradictoire = montantSeul && (debitOk || creditOk);

  return {
    totalLignes,
    date: e.colDateTexte
      ? { ok: true, detail: e.colDateTexte }
      : {
          ok: false,
          detail:
            "Novanta n'a pas trouvé de colonne de date. Renommez-la par exemple Date, Date transaction ou Date opération.",
        },
    libelle: e.colLibelleTexte
      ? { ok: true, detail: e.colLibelleTexte }
      : {
          ok: false,
          detail:
            "Novanta n'a pas trouvé de colonne décrivant les transactions. Renommez-la par exemple Libellé ou Description.",
        },
    montant: contradictoire
      ? {
          ok: false,
          detail:
            "Novanta ne peut pas déterminer quelles opérations sont des dépenses. Utilisez soit une colonne Montant avec des valeurs positives et négatives, soit deux colonnes Débit et Crédit.",
        }
      : montantSeul
        ? { ok: true, detail: e.colMontantTexte as string }
        : debitOk && creditOk
          ? { ok: true, detail: `${e.colDebitTexte} / ${e.colCreditTexte}` }
          : { ok: false, detail: "Novanta n'a trouvé ni colonne Montant, ni colonnes Débit / Crédit." },
  };
}

function estVide(valeur: unknown): boolean {
  return valeur === undefined || valeur === null || String(valeur).trim() === "";
}

function ligneVide(ligne: unknown[], e: EntetePotentielle): boolean {
  const colonnes = [e.colDate, e.colLibelle, e.colMontant, e.colDebit, e.colCredit].filter(
    (c): c is number => c !== null
  );
  return colonnes.every((c) => estVide(ligne[c]));
}

/**
 * Analyse une grille déjà extraite (tableau de lignes de cellules brutes). Séparée de la lecture
 * du fichier pour rester facilement testable sans dépendre d'un vrai binaire .xlsx.
 */
export function analyserGrilleBancaire(grille: unknown[][]): ResultatAnalyseBancaire {
  const fenetre = grille.slice(0, FENETRE_RECHERCHE_ENTETE);
  const candidats = fenetre.map((ligne, i) => analyserLigneEntete(ligne ?? [], i));
  const entete = candidats.find(enteteValideEtNonContradictoire);

  if (!entete) {
    const meilleure = candidats.reduce<EntetePotentielle | null>(
      (meilleur, c) => (meilleur === null || scoreEntete(c) > scoreEntete(meilleur) ? c : meilleur),
      null
    ) ?? enteteVide(0);
    const totalLignesRestantes = Math.max(0, grille.length - (meilleure.ligneIndex + 1));
    throw new ErreurImportBancaire("Import impossible.", construireDiagnostic(meilleure, totalLignesRestantes));
  }

  const lignesBrutes = grille.slice(entete.ligneIndex + 1).filter((ligne) => !ligneVide(ligne ?? [], entete));
  const totalLignesAnalysees = lignesBrutes.length;

  if (totalLignesAnalysees === 0) {
    throw new ErreurImportBancaire("Aucune ligne de données n'a été trouvée sous l'en-tête détecté.");
  }

  const utiliseMontantUnique = entete.colMontant !== null;
  const signedAmounts: (number | null)[] = new Array(totalLignesAnalysees).fill(null);
  let ignoresDebitCreditAmbigu = 0;

  if (utiliseMontantUnique) {
    const colMontant = entete.colMontant as number;
    const brutes = lignesBrutes.map((l) => l[colMontant]);
    const resolution = resoudreColonneMontants(brutes);
    if (!resolution.ok) {
      throw new ErreurImportBancaire(
        `Novanta ne peut pas déterminer de manière fiable comment certains montants doivent être interprétés. Vérifiez le format de la colonne "${entete.colMontantTexte}".`
      );
    }

    const nbNonVides = brutes.filter((v) => !estVide(v)).length;
    const nbEchecs = resolution.valeurs.filter((v, i) => v === null && !estVide(brutes[i])).length;
    if (nbNonVides > 0 && nbEchecs / nbNonVides > SEUIL_ECHEC_GLOBAL) {
      throw new ErreurImportBancaire(`Novanta n'a pas pu interpréter le format de la colonne "${entete.colMontantTexte}".`);
    }

    resolution.valeurs.forEach((v, i) => {
      signedAmounts[i] = v;
    });

    const valeursConnues = resolution.valeurs.filter((v): v is number => v !== null);
    const auMoinsUneNegative = valeursConnues.some((v) => v < 0);
    if (valeursConnues.length > 0 && !auMoinsUneNegative) {
      throw new ErreurImportBancaire(
        "Novanta ne peut pas déterminer quelles opérations sont des dépenses. Utilisez soit une colonne Montant avec des valeurs positives et négatives, soit deux colonnes Débit et Crédit."
      );
    }
  } else {
    const colDebit = entete.colDebit as number;
    const colCredit = entete.colCredit as number;
    const brutesDebit = lignesBrutes.map((l) => l[colDebit]);
    const brutesCredit = lignesBrutes.map((l) => l[colCredit]);
    const debitPresent = brutesDebit.map((v) => !estVide(v));
    const creditPresent = brutesCredit.map((v) => !estVide(v));

    const resolutionDebit = resoudreColonneMontants(brutesDebit.map((v, i) => (debitPresent[i] ? v : "")));
    const resolutionCredit = resoudreColonneMontants(brutesCredit.map((v, i) => (creditPresent[i] ? v : "")));
    if (!resolutionDebit.ok || !resolutionCredit.ok) {
      throw new ErreurImportBancaire(
        `Novanta ne peut pas déterminer de manière fiable comment certains montants doivent être interprétés. Vérifiez le format des colonnes "${entete.colDebitTexte}" / "${entete.colCreditTexte}".`
      );
    }

    for (let i = 0; i < totalLignesAnalysees; i++) {
      if (debitPresent[i] && creditPresent[i]) {
        ignoresDebitCreditAmbigu++;
        continue;
      }
      if (debitPresent[i]) {
        const v = resolutionDebit.valeurs[i];
        signedAmounts[i] = v === null ? null : -Math.abs(v);
      } else if (creditPresent[i]) {
        const v = resolutionCredit.valeurs[i];
        signedAmounts[i] = v === null ? null : Math.abs(v);
      }
    }
  }

  const colDate = entete.colDate as number;
  const datesBrutes = lignesBrutes.map((l) => l[colDate]);
  const datesParsees = datesBrutes.map((v) => analyserDateBancaire(v));
  const nbDatesNonVides = datesBrutes.filter((v) => !estVide(v)).length;
  const nbEchecsDate = datesParsees.filter((d, i) => d === null && !estVide(datesBrutes[i])).length;
  if (nbDatesNonVides > 0 && nbEchecsDate / nbDatesNonVides > SEUIL_ECHEC_GLOBAL) {
    throw new ErreurImportBancaire(
      `Novanta n'a pas pu interpréter certaines dates de la colonne "${entete.colDateTexte}". Utilisez par exemple 31/08/2026 ou 31.08.26.`
    );
  }

  const colLibelle = entete.colLibelle as number;
  const transactions: NormalizedBankTransaction[] = [];
  let ignoresLibelleVide = 0;
  let ignoresDateIllisible = 0;
  let ignoresMontantIllisible = 0;
  let ignoresAucunMontant = 0;

  for (let i = 0; i < totalLignesAnalysees; i++) {
    const libelleOriginal = String(lignesBrutes[i][colLibelle] ?? "").trim();
    const date = datesParsees[i];
    const montant = signedAmounts[i];

    if (!libelleOriginal) {
      ignoresLibelleVide++;
      continue;
    }
    if (!date) {
      ignoresDateIllisible++;
      continue;
    }
    if (montant === null) {
      if (utiliseMontantUnique) ignoresMontantIllisible++;
      else ignoresAucunMontant++;
      continue;
    }

    transactions.push({
      date,
      labelOriginal: libelleOriginal,
      labelNormalized: normaliserLibelleBancaire(libelleOriginal),
      signedAmount: montant,
    });
  }

  const raisonsIgnorees: string[] = [];
  if (ignoresLibelleVide > 0) raisonsIgnorees.push(`${ignoresLibelleVide} ligne(s) ignorée(s) car leur libellé était vide.`);
  if (ignoresDateIllisible > 0)
    raisonsIgnorees.push(`${ignoresDateIllisible} ligne(s) ignorée(s) car leur date n'a pas pu être lue.`);
  if (ignoresMontantIllisible > 0)
    raisonsIgnorees.push(`${ignoresMontantIllisible} ligne(s) ignorée(s) car leur montant n'a pas pu être lu.`);
  if (ignoresAucunMontant > 0)
    raisonsIgnorees.push(`${ignoresAucunMontant} ligne(s) ignorée(s) car ni Débit ni Crédit n'était renseigné.`);
  if (ignoresDebitCreditAmbigu > 0)
    raisonsIgnorees.push(`${ignoresDebitCreditAmbigu} ligne(s) ignorée(s) car Débit et Crédit étaient tous deux renseignés.`);

  if (transactions.length === 0) {
    throw new ErreurImportBancaire("Aucune transaction exploitable n'a été trouvée dans ce fichier.");
  }

  const datesTriees = transactions.map((t) => t.date).sort();
  const lignesIgnorees =
    ignoresLibelleVide + ignoresDateIllisible + ignoresMontantIllisible + ignoresAucunMontant + ignoresDebitCreditAmbigu;

  return {
    transactions,
    totalLignesAnalysees,
    lignesIgnorees,
    raisonsIgnorees,
    periode: { debut: datesTriees[0], fin: datesTriees[datesTriees.length - 1] },
    colonneDate: entete.colDateTexte as string,
    colonneLibelle: entete.colLibelleTexte as string,
  };
}

/**
 * Point d'entrée principal : lit un fichier .xlsx sélectionné par l'utilisateur et retourne les
 * transactions normalisées. Aucune formule n'est exécutée (xlsx.js ne fait que lire les valeurs
 * déjà calculées) et aucun contenu du fichier n'est jamais journalisé ni rendu en HTML.
 */
export async function analyserFichierBancaireXlsx(fichier: File): Promise<ResultatAnalyseBancaire> {
  if (!fichier.name.toLowerCase().endsWith(".xlsx")) {
    throw new ErreurImportBancaire("Format de fichier non pris en charge. Seul le format .xlsx est accepté.");
  }
  if (fichier.size > TAILLE_MAX_OCTETS) {
    throw new ErreurImportBancaire(`Fichier trop volumineux (limite : ${TAILLE_MAX_OCTETS / (1024 * 1024)} Mo).`);
  }

  let classeur: XLSX.WorkBook;
  try {
    const buffer = await fichier.arrayBuffer();
    classeur = XLSX.read(buffer, { type: "array", cellDates: true });
  } catch {
    throw new ErreurImportBancaire("Impossible de lire ce fichier. Vérifiez qu'il s'agit bien d'un fichier Excel (.xlsx) valide.");
  }

  const feuille = classeur.Sheets[classeur.SheetNames[0]];
  if (!feuille) {
    throw new ErreurImportBancaire("Ce fichier ne contient aucune feuille exploitable.");
  }

  const grille = XLSX.utils.sheet_to_json<unknown[]>(feuille, { header: 1, raw: true, defval: "" }) as unknown[][];
  if (grille.length > LIGNES_MAX) {
    throw new ErreurImportBancaire(`Ce fichier contient trop de lignes (limite : ${LIGNES_MAX}).`);
  }

  return analyserGrilleBancaire(grille);
}
