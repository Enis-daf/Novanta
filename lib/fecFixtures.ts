/**
 * FEC SYNTHÉTIQUES pour les tests et la démonstration : aucune donnée réelle. Le montant 100 000,00 s'écrit
 * « 100000,00 », comme le demande le format officiel.
 */

export const ENTETE_FEC = "JournalCode\tJournalLib\tEcritureNum\tEcritureDate\tCompteNum\tCompteLib\tCompAuxNum\tCompAuxLib\tPieceRef\tPieceDate\tEcritureLib\tDebit\tCredit\tEcritureLet\tDateLet\tValidDate\tMontantdevise\tIdevise";

export interface LigneSynthetique {
  journal?: string;
  numero: string;
  date: string; // AAAAMMJJ
  compte: string;
  libelle?: string;
  debit?: string;
  credit?: string;
}

export function ligneFec(l: LigneSynthetique, separateur = "\t"): string {
  return [l.journal ?? "OD", l.journal === "AN" ? "A nouveaux" : "Operations diverses", l.numero, l.date, l.compte, l.libelle ?? `Compte ${l.compte}`, "", "", "P1", l.date, "Libelle synthetique", l.debit ?? "0,00", l.credit ?? "0,00", "", "", l.date, "", ""].join(separateur);
}

export function fecDepuisLignes(lignes: LigneSynthetique[], separateur = "\t"): string {
  return [ENTETE_FEC.split("\t").join(separateur), ...lignes.map((l) => ligneFec(l, separateur))].join("\r\n") + "\r\n";
}

function montant(v: number): string {
  return v.toFixed(2).replace(".", ",");
}

/** Écriture équilibrée en deux lignes : débit sur un compte, crédit sur l'autre. */
function ecriture(numero: string, date: string, debiter: string, crediter: string, valeur: number, journal = "OD"): LigneSynthetique[] {
  return [
    { journal, numero, date, compte: debiter, debit: montant(valeur) },
    { journal, numero, date, compte: crediter, credit: montant(valeur) },
  ];
}

/**
 * Un exercice complet, avec ses écritures annuelles de clôture passées sur le dernier mois : à-nouveaux,
 * ventes, achats, salaires, avoir, extourne, variation de stock, dotation, impôt.
 */
export function exerciceSynthetique(options: { debut?: string; annee?: number; facteur?: number } = {}): LigneSynthetique[] {
  const annee = options.annee ?? 2024;
  const moisDebut = Number((options.debut ?? `${annee}-01`).slice(5, 7));
  const facteur = options.facteur ?? 1;
  const lignes: LigneSynthetique[] = [];
  const date = (rang: number, jour: string) => {
    const m = moisDebut - 1 + rang;
    return `${annee + Math.floor(m / 12)}${String((m % 12) + 1).padStart(2, "0")}${jour}`;
  };
  lignes.push(...ecriture("AN1", date(0, "01"), "512000", "101000", 50_000, "AN"));
  for (let rang = 0; rang < 12; rang++) {
    const n = String(rang + 1).padStart(2, "0");
    lignes.push(...ecriture(`VE${n}`, date(rang, "28"), "411000", "706000", 100_000 * facteur, "VE"));
    lignes.push(...ecriture(`AC${n}`, date(rang, "15"), "607000", "401000", 40_000 * facteur, "AC"));
    lignes.push(...ecriture(`SA${n}`, date(rang, "27"), "641100", "421000", 20_000 * facteur, "SA"));
    lignes.push(...ecriture(`LO${n}`, date(rang, "05"), "613200", "401000", 5_000 * facteur, "AC"));
  }
  // Avoir client : un débit sur un compte de produit.
  lignes.push(...ecriture("AV01", date(3, "20"), "706000", "411000", 2_000, "VE"));
  // Charge constatée puis extournée le mois suivant.
  lignes.push(...ecriture("EX01", date(5, "30"), "613200", "408000", 1_000));
  lignes.push(...ecriture("EX02", date(6, "01"), "408000", "613200", 1_000));
  // Écritures annuelles, passées une seule fois sur le dernier mois.
  lignes.push(...ecriture("CL01", date(11, "28"), "371000", "603700", 30_000));
  lignes.push(...ecriture("CL02", date(11, "28"), "681120", "281000", 24_000));
  lignes.push(...ecriture("CL03", date(11, "28"), "695000", "444000", 50_000));
  return lignes;
}
