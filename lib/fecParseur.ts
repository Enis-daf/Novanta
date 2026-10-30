import { estCompteDeResultat, normaliserCompte } from "./comptaCorrespondance";
import { SoldeCompte } from "./comptaPnl";

/**
 * Lecture d'un Fichier des Écritures Comptables — pur, sans réseau. Tourne dans le navigateur : le fichier
 * brut ne quitte pas le poste, seules les balances mensuelles partent au serveur.
 *
 * Format de référence : article A. 47 A-1 du LPF. 18 champs, Debit/Credit ou Montant/Sens (D/C ou +1/-1),
 * séparateur tabulation ou « | », ASCII, ISO 8859-15 ou UTF-8, dates AAAAMMJJ, virgule décimale sans
 * séparateur de milliers, signe en premier ou en dernier caractère, nom SirenFECAAAAMMJJ.
 *
 * Ce qui s'écarte de ce format mais reste lisible sans ambiguïté est accepté et signalé. Rien n'est corrigé :
 * une ligne illisible bloque l'import, car la balance serait fausse sans qu'on sache de combien. Seuls les
 * cinq champs dont dépend le calcul sont exigés ; l'absence des autres est signalée sans bloquer.
 */

export type GraviteAnomalie = "bloquante" | "non_bloquante" | "information";

// Pas de valeur comptable dans une anomalie : des compteurs et des numéros de ligne seulement.
export interface AnomalieFec {
  code: string;
  gravite: GraviteAnomalie;
  message: string;
  nombre?: number;
  lignes?: number[];
}

export interface BalanceFec {
  mois: string; // YYYY-MM
  compte: string;
  debit: number;
  credit: number;
  nombreLignes: number;
}

export interface AnalyseFec {
  nomFichier: string;
  encodage: string;
  separateur: string;
  formatMontants: "debit_credit" | "montant_sens";
  nombreLignes: number;
  nombreEcritures: number;
  nombreComptes: number;
  totalDebit: number;
  totalCredit: number;
  premiereDate: string | null;
  derniereDate: string | null;
  exercice: { debut: string; fin: string; sourceFin: "nom_du_fichier" | "dernieres_ecritures" } | null;
  balances: BalanceFec[];
  libelles: Record<string, string>;
  anomalies: AnomalieFec[];
  bloquant: boolean;
  controles: {
    ecrituresDesequilibrees: number;
    lignesANouveau: number;
    lignesANouveauDeResultat: number;
    ecrituresDeSoldeExclues: number;
    // Produits moins charges reconstitués, et mouvements du compte de résultat (12) dans le fichier.
    resultatReconstitue: number;
    mouvementsCompte12: number | null;
    lignesIdentiques: number;
  };
}

const CHAMPS_OFFICIELS = [
  "journalcode", "journallib", "ecriturenum", "ecrituredate", "comptenum", "comptelib", "compauxnum", "compauxlib", "pieceref", "piecedate",
  "ecriturelib", "debit", "credit", "ecriturelet", "datelet", "validdate", "montantdevise", "idevise",
];

const SEPARATEURS: { caractere: string; nom: string; officiel: boolean }[] = [
  { caractere: "\t", nom: "tabulation", officiel: true },
  { caractere: "|", nom: "barre verticale", officiel: true },
  { caractere: ";", nom: "point-virgule", officiel: false },
  { caractere: ",", nom: "virgule", officiel: false },
];

const MAX_LIGNES_CITEES = 20;

function normaliserEntete(champ: string): string {
  return champ
    .trim()
    .replace(/^"|"$/g, "")
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase();
}

/** Montant en centimes, ou null s'il n'est pas lisible sans ambiguïté. */
export function lireMontant(brut: string): { centimes: number; sousLeCentime: boolean } | null {
  let texte = brut.trim().replace(/[\s  ]/g, "");
  if (texte === "") return { centimes: 0, sousLeCentime: false };
  let signe = 1;
  if (/^[+-]/.test(texte)) {
    if (texte[0] === "-") signe = -1;
    texte = texte.slice(1);
  } else if (/[+-]$/.test(texte)) {
    if (texte.endsWith("-")) signe = -1;
    texte = texte.slice(0, -1);
  }
  const virgules = (texte.match(/,/g) ?? []).length;
  const points = (texte.match(/\./g) ?? []).length;
  if (virgules > 0 && points > 0) {
    // Les deux : le dernier est le décimal, l'autre un séparateur de milliers.
    if (texte.lastIndexOf(",") > texte.lastIndexOf(".")) {
      if (virgules > 1) return null;
      texte = texte.replace(/\./g, "").replace(",", ".");
    } else {
      if (points > 1) return null;
      texte = texte.replace(/,/g, "");
    }
  } else if (virgules > 1 || points > 1) {
    // 1.234.567 : milliers seulement, si chaque groupe compte bien trois chiffres.
    if (!/^\d{1,3}([.,]\d{3})+$/.test(texte)) return null;
    texte = texte.replace(/[.,]/g, "");
  } else if (virgules === 1) {
    texte = texte.replace(",", ".");
  }
  if (!/^\d+(\.\d+)?$/.test(texte)) return null;
  const decimales = texte.split(".")[1] ?? "";
  const sousLeCentime = decimales.length > 2 && /[1-9]/.test(decimales.slice(2));
  return { centimes: signe * Math.round(Number(texte) * 100), sousLeCentime };
}

function dateValide(annee: string, mois: string, jour: string): string | null {
  const iso = `${annee}-${mois}-${jour}`;
  const d = new Date(`${iso}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === iso ? iso : null;
}

/** Date en YYYY-MM-DD, et si son format est l'officiel. Une date impossible n'est jamais corrigée. */
export function lireDate(brut: string): { date: string; officiel: boolean } | null {
  const t = brut.trim();
  let m = /^(\d{4})(\d{2})(\d{2})$/.exec(t);
  if (m) {
    const date = dateValide(m[1], m[2], m[3]);
    return date ? { date, officiel: true } : null;
  }
  m = /^(\d{4})-(\d{2})-(\d{2})/.exec(t);
  if (m) {
    const date = dateValide(m[1], m[2], m[3]);
    return date ? { date, officiel: false } : null;
  }
  m = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(t);
  if (m) {
    const date = dateValide(m[3], m[2], m[1]);
    return date ? { date, officiel: false } : null;
  }
  return null;
}

/** Date de clôture portée par le nom du fichier (SirenFECAAAAMMJJ, parfois suffixé), si elle existe. */
export function dateDeClotureDuNom(nomFichier: string): string | null {
  const m = /FEC(\d{4})(\d{2})(\d{2})/i.exec(nomFichier);
  return m ? dateValide(m[1], m[2], m[3]) : null;
}

function decouper(ligne: string, separateur: string): string[] {
  if (separateur === "\t" || !ligne.includes('"')) return ligne.split(separateur);
  const champs: string[] = [];
  let courant = "";
  let entre = false;
  for (let i = 0; i < ligne.length; i++) {
    const c = ligne[i];
    if (c === '"') {
      if (entre && ligne[i + 1] === '"') {
        courant += '"';
        i++;
      } else entre = !entre;
    } else if (c === separateur && !entre) {
      champs.push(courant);
      courant = "";
    } else courant += c;
  }
  champs.push(courant);
  return champs;
}

function dernierJourDuMois(mois: string): string {
  const [annee, numero] = mois.split("-").map(Number);
  return new Date(Date.UTC(annee, numero, 0)).toISOString().slice(0, 10);
}

function moisEcoules(debut: string, fin: string): number {
  return (Number(fin.slice(0, 4)) - Number(debut.slice(0, 4))) * 12 + Number(fin.slice(5, 7)) - Number(debut.slice(5, 7)) + 1;
}

// Journal de reprise des soldes : le texte officiel n'en fixe pas le code, seuls les usages courants comptent.
const CODES_A_NOUVEAU = new Set(["AN", "RAN", "ANO", "AO", "A-N", "A.N", "A N"]);
function estJournalANouveau(code: string, libelle: string): boolean {
  return CODES_A_NOUVEAU.has(code.trim().toUpperCase()) || /nouveau/i.test(libelle);
}

/** Empreinte rapide d'une ligne (53 bits) : repérer des lignes identiques sans les garder en mémoire. */
function empreinteLigne(texte: string): number {
  let h1 = 0xdeadbeef;
  let h2 = 0x41c6ce57;
  for (let i = 0; i < texte.length; i++) {
    const c = texte.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 2654435761);
    h2 = Math.imul(h2 ^ c, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return 4294967296 * (2097151 & h2) + (h1 >>> 0);
}

interface EtatEcriture {
  ecart: number; // débit moins crédit, en centimes
  lignes: number;
  a12: boolean;
  a67: boolean;
  // Lignes en 6, 7 ou 12 : seules celles-ci peuvent appartenir à une écriture de solde.
  retenues: { compte: string; mois: string; debit: number; credit: number }[];
}

/** Analyseur de lignes déjà décodées : une ligne à la fois, jamais le fichier entier en mémoire. */
export class AnalyseurFec {
  private entete: Map<string, number> | null = null;
  private separateur: (typeof SEPARATEURS)[number] | null = null;
  private nombreChamps = 0;
  private numeroLigne = 0;
  private lignesLues = 0;
  private formatMontants: AnalyseFec["formatMontants"] = "debit_credit";
  private cumuls = new Map<string, { mois: string; compte: string; debit: number; credit: number; nombreLignes: number }>();
  private libelles = new Map<string, string>();
  private ecritures = new Map<string, EtatEcriture>();
  private lignesVues = new Set<number>();
  private premiere: string | null = null;
  private derniere: string | null = null;
  private totalDebit = 0;
  private totalCredit = 0;
  private lignesAN = 0;
  private lignesANResultat = 0;
  private identiques = 0;
  private datesNonOfficielles = 0;
  private sousLeCentime = 0;
  private montantsNegatifs = 0;
  private problemes = new Map<string, { nombre: number; lignes: number[] }>();
  private erreurStructure: AnomalieFec[] = [];
  private notesStructure: AnomalieFec[] = [];

  private noter(code: string, numero: number) {
    const p = this.problemes.get(code) ?? { nombre: 0, lignes: [] };
    p.nombre += 1;
    if (p.lignes.length < MAX_LIGNES_CITEES) p.lignes.push(numero);
    this.problemes.set(code, p);
  }

  private lireEntete(ligne: string) {
    const propre = ligne.replace(/^﻿/, "");
    let meilleur: { s: (typeof SEPARATEURS)[number]; n: number } | null = null;
    for (const s of SEPARATEURS) {
      const n = propre.split(s.caractere).length;
      if (n > 1 && (!meilleur || n > meilleur.n)) meilleur = { s, n };
    }
    if (!meilleur) {
      this.erreurStructure.push({ code: "separateur", gravite: "bloquante", message: "Aucun séparateur de colonnes reconnu sur la première ligne." });
      this.entete = new Map();
      return;
    }
    this.separateur = meilleur.s;
    const colonnes = decouper(propre, meilleur.s.caractere).map(normaliserEntete);
    this.nombreChamps = colonnes.length;
    const carte = new Map<string, number>();
    colonnes.forEach((c, i) => {
      if (!carte.has(c)) carte.set(c, i);
    });
    this.entete = carte;

    const aDebitCredit = carte.has("debit") && carte.has("credit");
    const aMontantSens = carte.has("montant") && carte.has("sens");
    this.formatMontants = aDebitCredit || !aMontantSens ? "debit_credit" : "montant_sens";
    const manquants = ["journalcode", "ecriturenum", "ecrituredate", "comptenum"].filter((c) => !carte.has(c));
    if (!aDebitCredit && !aMontantSens) manquants.push("debit et credit, ou montant et sens");
    if (manquants.length > 0) {
      this.erreurStructure.push({ code: "colonnes_manquantes", gravite: "bloquante", message: `Colonnes indispensables absentes : ${manquants.join(", ")}.` });
    }
    const facultatifs = CHAMPS_OFFICIELS.filter((c) => !carte.has(c) && !(aMontantSens && (c === "debit" || c === "credit")) && !manquants.includes(c));
    if (facultatifs.length > 0) {
      this.notesStructure.push({ code: "champs_officiels_absents", gravite: "non_bloquante", message: `Champs du format officiel absents, sans effet sur le calcul : ${facultatifs.join(", ")}.`, nombre: facultatifs.length });
    }
    if (!meilleur.s.officiel) {
      this.notesStructure.push({ code: "separateur_non_officiel", gravite: "non_bloquante", message: `Séparateur « ${meilleur.s.nom} » : le format officiel prévoit la tabulation ou « | ».` });
    }
  }

  ajouterLigne(ligne: string) {
    this.numeroLigne += 1;
    if (ligne.trim() === "") return;
    if (this.entete === null) {
      this.lireEntete(ligne);
      return;
    }
    if (this.erreurStructure.length > 0 || !this.separateur) return;
    const numero = this.numeroLigne;
    this.lignesLues += 1;

    const empreinte = empreinteLigne(ligne);
    if (this.lignesVues.has(empreinte)) this.identiques += 1;
    else this.lignesVues.add(empreinte);

    const champs = decouper(ligne, this.separateur.caractere);
    if (champs.length !== this.nombreChamps) {
      this.noter("ligne_mal_formee", numero);
      return;
    }
    const lire = (nom: string) => {
      const i = this.entete!.get(nom);
      return i === undefined ? "" : (champs[i] ?? "").trim();
    };

    const date = lireDate(lire("ecrituredate"));
    if (!date) {
      this.noter("date_illisible", numero);
      return;
    }
    if (!date.officiel) this.datesNonOfficielles += 1;

    const compteBrut = lire("comptenum");
    const compte = normaliserCompte(compteBrut);
    if (!compte) {
      this.noter("compte_illisible", numero);
      return;
    }

    let debit = 0;
    let credit = 0;
    if (this.formatMontants === "debit_credit") {
      const d = lireMontant(lire("debit"));
      const c = lireMontant(lire("credit"));
      if (!d || !c) {
        this.noter("montant_illisible", numero);
        return;
      }
      debit = d.centimes;
      credit = c.centimes;
      if (d.sousLeCentime || c.sousLeCentime) this.sousLeCentime += 1;
    } else {
      const m = lireMontant(lire("montant"));
      const sens = lire("sens").toUpperCase();
      if (!m || !["D", "C", "+1", "-1"].includes(sens)) {
        this.noter("montant_illisible", numero);
        return;
      }
      if (sens === "D" || sens === "+1") debit = m.centimes;
      else credit = m.centimes;
      if (m.sousLeCentime) this.sousLeCentime += 1;
    }
    if (debit < 0 || credit < 0) this.montantsNegatifs += 1;

    const mois = date.date.slice(0, 7);
    if (this.premiere === null || date.date < this.premiere) this.premiere = date.date;
    if (this.derniere === null || date.date > this.derniere) this.derniere = date.date;

    const cle = `${compte}|${mois}`;
    const cumul = this.cumuls.get(cle) ?? { mois, compte, debit: 0, credit: 0, nombreLignes: 0 };
    cumul.debit += debit;
    cumul.credit += credit;
    cumul.nombreLignes += 1;
    this.cumuls.set(cle, cumul);
    this.totalDebit += debit;
    this.totalCredit += credit;

    const libelle = lire("comptelib");
    if (libelle && !this.libelles.has(compte)) this.libelles.set(compte, libelle);

    const resultat = estCompteDeResultat(compte);
    if (estJournalANouveau(lire("journalcode"), lire("journallib"))) {
      this.lignesAN += 1;
      if (resultat) this.lignesANResultat += 1;
    }

    const cleEcriture = `${lire("journalcode")}\u0000${lire("ecriturenum")}`;
    const ecriture = this.ecritures.get(cleEcriture) ?? { ecart: 0, lignes: 0, a12: false, a67: false, retenues: [] };
    ecriture.ecart += debit - credit;
    ecriture.lignes += 1;
    const de12 = compte.startsWith("12");
    if (de12) ecriture.a12 = true;
    if (resultat) ecriture.a67 = true;
    if (de12 || resultat) ecriture.retenues.push({ compte, mois, debit, credit });
    this.ecritures.set(cleEcriture, ecriture);
  }

  terminer(meta: { nomFichier: string; encodage: string }): AnalyseFec {
    const anomalies: AnomalieFec[] = [...this.erreurStructure, ...this.notesStructure];
    if (this.entete === null) anomalies.push({ code: "fichier_vide", gravite: "bloquante", message: "Le fichier est vide." });
    else if (this.lignesLues === 0 && this.erreurStructure.length === 0) anomalies.push({ code: "aucune_ligne", gravite: "bloquante", message: "Le fichier ne contient aucune écriture." });

    const messages: Record<string, string> = {
      ligne_mal_formee: "Lignes dont le nombre de colonnes diffère de l'en-tête.",
      date_illisible: "Lignes dont la date d'écriture est absente ou impossible.",
      compte_illisible: "Lignes dont le numéro de compte est absent ou illisible.",
      montant_illisible: "Lignes dont le montant ou le sens est illisible.",
    };
    for (const [code, p] of this.problemes) anomalies.push({ code, gravite: "bloquante", message: messages[code], nombre: p.nombre, lignes: p.lignes });

    // Écritures soldant les comptes de gestion vers le compte de résultat (6 et 7 contre 12) : les garder
    // ramènerait le P&L à zéro. Écartées de la balance, et dites à l'utilisateur.
    let soldesExclus = 0;
    for (const e of this.ecritures.values()) {
      if (!e.a12 || !e.a67 || e.retenues.length !== e.lignes) continue;
      soldesExclus += 1;
      for (const l of e.retenues) {
        const cumul = this.cumuls.get(`${l.compte}|${l.mois}`)!;
        cumul.debit -= l.debit;
        cumul.credit -= l.credit;
        cumul.nombreLignes -= 1;
        this.totalDebit -= l.debit;
        this.totalCredit -= l.credit;
      }
    }

    let desequilibrees = 0;
    for (const e of this.ecritures.values()) if (e.ecart !== 0) desequilibrees += 1;

    const balances = [...this.cumuls.values()]
      .filter((c) => c.nombreLignes > 0)
      .map((c) => ({ ...c, debit: c.debit / 100, credit: c.credit / 100 }))
      .sort((a, b) => a.mois.localeCompare(b.mois) || a.compte.localeCompare(b.compte));

    let resultat = 0;
    let mouvements12 = 0;
    let a12 = false;
    for (const c of this.cumuls.values()) {
      if (estCompteDeResultat(c.compte)) resultat += c.credit - c.debit;
    }
    for (const e of this.ecritures.values()) {
      // Le résultat de l'exercice se lit dans une écriture de solde ; une reprise d'à-nouveau en 12 n'en dit rien.
      if (!e.a12 || !e.a67) continue;
      for (const l of e.retenues) {
        if (l.compte.startsWith("12")) {
          mouvements12 += l.credit - l.debit;
          a12 = true;
        }
      }
    }

    if (this.totalDebit !== this.totalCredit && this.lignesLues > 0 && this.erreurStructure.length === 0) {
      anomalies.push({ code: "fichier_desequilibre", gravite: "bloquante", message: "Le total des débits diffère du total des crédits sur le fichier." });
    }
    if (desequilibrees > 0) anomalies.push({ code: "ecritures_desequilibrees", gravite: "non_bloquante", message: "Écritures dont le débit diffère du crédit.", nombre: desequilibrees });
    if (soldesExclus > 0) anomalies.push({ code: "ecritures_de_solde", gravite: "information", message: "Écritures soldant les charges et produits vers le compte de résultat (12) : écartées de la balance, sinon le P&L serait nul.", nombre: soldesExclus });
    if (a12 && mouvements12 !== resultat) anomalies.push({ code: "resultat_different", gravite: "non_bloquante", message: "Le résultat reconstitué diffère des mouvements du compte de résultat (12) dans le fichier." });
    if (this.lignesANResultat > 0) anomalies.push({ code: "a_nouveau_de_resultat", gravite: "non_bloquante", message: "Lignes de reprise d'à-nouveau sur des comptes de charges ou de produits : elles entrent dans le P&L.", nombre: this.lignesANResultat });
    if (this.lignesAN > 0) anomalies.push({ code: "a_nouveaux", gravite: "information", message: "Lignes de reprise d'à-nouveau repérées : conservées dans la balance, sans effet sur le P&L si elles portent sur le bilan.", nombre: this.lignesAN });
    if (this.datesNonOfficielles > 0) anomalies.push({ code: "dates_non_officielles", gravite: "non_bloquante", message: "Dates lisibles, mais hors du format officiel AAAAMMJJ.", nombre: this.datesNonOfficielles });
    if (this.sousLeCentime > 0) anomalies.push({ code: "sous_le_centime", gravite: "non_bloquante", message: "Montants à plus de deux décimales : arrondis au centime.", nombre: this.sousLeCentime });
    if (this.montantsNegatifs > 0) anomalies.push({ code: "montants_negatifs", gravite: "information", message: "Montants négatifs : repris avec leur signe.", nombre: this.montantsNegatifs });
    if (this.identiques > 0) anomalies.push({ code: "lignes_identiques", gravite: "non_bloquante", message: "Lignes strictement identiques dans le fichier : comptées telles quelles, à vérifier s'il s'agit d'un doublon d'export.", nombre: this.identiques });

    // Exercice : le nom du fichier porte la date de clôture quand il suit la norme. À vérifier par l'utilisateur.
    let exercice: AnalyseFec["exercice"] = null;
    if (this.premiere && this.derniere) {
      const finNom = dateDeClotureDuNom(meta.nomFichier);
      const fin = finNom && finNom >= this.derniere ? finNom : dernierJourDuMois(this.derniere.slice(0, 7));
      exercice = { debut: `${this.premiere.slice(0, 7)}-01`, fin, sourceFin: finNom && finNom >= this.derniere ? "nom_du_fichier" : "dernieres_ecritures" };
      if (finNom && finNom < this.derniere) anomalies.push({ code: "ecritures_apres_cloture", gravite: "non_bloquante", message: "Des écritures sont datées après la date de clôture portée par le nom du fichier." });
      const duree = moisEcoules(exercice.debut, exercice.fin);
      if (duree > 24) anomalies.push({ code: "periode_longue", gravite: "non_bloquante", message: `Le fichier couvre ${duree} mois : vérifiez les dates, ou s'il réunit plusieurs exercices.` });
      else if (duree !== 12) anomalies.push({ code: "exercice_atypique", gravite: "information", message: `Le fichier couvre ${duree} mois : vérifiez les bornes de l'exercice.` });
    }

    return {
      nomFichier: meta.nomFichier,
      encodage: meta.encodage,
      separateur: this.separateur?.nom ?? "inconnu",
      formatMontants: this.formatMontants,
      nombreLignes: this.lignesLues,
      nombreEcritures: this.ecritures.size,
      nombreComptes: new Set(balances.map((b) => b.compte)).size,
      totalDebit: this.totalDebit / 100,
      totalCredit: this.totalCredit / 100,
      premiereDate: this.premiere,
      derniereDate: this.derniere,
      exercice,
      balances,
      libelles: Object.fromEntries(this.libelles),
      anomalies,
      bloquant: anomalies.some((a) => a.gravite === "bloquante"),
      controles: {
        ecrituresDesequilibrees: desequilibrees,
        lignesANouveau: this.lignesAN,
        lignesANouveauDeResultat: this.lignesANResultat,
        ecrituresDeSoldeExclues: soldesExclus,
        resultatReconstitue: resultat / 100,
        mouvementsCompte12: a12 ? mouvements12 / 100 : null,
        lignesIdentiques: this.identiques,
      },
    };
  }
}

/** Encodage : UTF-16 si une marque l'annonce, UTF-8 si tout le fichier en est, sinon ISO 8859-15. */
function encodageDesPremiersOctets(octets: Uint8Array): string | null {
  if (octets[0] === 0xff && octets[1] === 0xfe) return "utf-16le";
  if (octets[0] === 0xfe && octets[1] === 0xff) return "utf-16be";
  return null;
}

async function lireAvecEncodage(lire: () => AsyncIterable<Uint8Array>, encodage: string, fatal: boolean, surLigne: (ligne: string) => void): Promise<void> {
  const decodeur = new TextDecoder(encodage, { fatal });
  let reste = "";
  for await (const morceau of lire()) {
    reste += decodeur.decode(morceau, { stream: true });
    const lignes = reste.split(/\r\n|\n|\r/);
    reste = lignes.pop() ?? "";
    for (const ligne of lignes) surLigne(ligne);
  }
  reste += decodeur.decode();
  if (reste !== "") surLigne(reste);
}

/**
 * Analyse un fichier lu par morceaux. `lire` peut être rappelée : si le fichier n'est pas de l'UTF-8 valide,
 * il est relu depuis le début en ISO 8859-15, sans rien garder de la première lecture.
 */
export async function analyserFec(lire: () => AsyncIterable<Uint8Array>, nomFichier: string): Promise<AnalyseFec> {
  let debut: Uint8Array | null = null;
  for await (const morceau of lire()) {
    debut = morceau;
    break;
  }
  const annonce = debut ? encodageDesPremiersOctets(debut) : null;
  if (annonce) {
    const analyseur = new AnalyseurFec();
    await lireAvecEncodage(lire, annonce, false, (l) => analyseur.ajouterLigne(l));
    return analyseur.terminer({ nomFichier, encodage: annonce === "utf-16le" ? "UTF-16 LE" : "UTF-16 BE" });
  }
  try {
    const analyseur = new AnalyseurFec();
    await lireAvecEncodage(lire, "utf-8", true, (l) => analyseur.ajouterLigne(l));
    return analyseur.terminer({ nomFichier, encodage: "UTF-8" });
  } catch (erreur) {
    if (!(erreur instanceof TypeError)) throw erreur;
    const analyseur = new AnalyseurFec();
    await lireAvecEncodage(lire, "iso-8859-15", false, (l) => analyseur.ajouterLigne(l));
    return analyseur.terminer({ nomFichier, encodage: "ISO 8859-15" });
  }
}

export interface ImportFecPrepare {
  nomFichier: string;
  exercice: { debut: string; fin: string; cloture: boolean };
  // [mois, compte, débit, crédit, nombre de lignes] : compact, une requête serveur est limitée à 4,5 Mo.
  lignes: [string, string, number, number, number][];
  libelles: Record<string, string>;
  resume: { lignes: number; ecritures: number; desequilibrees: number; ecrituresDeSolde: number; resultat: number; anomalies: { code: string; gravite: GraviteAnomalie; nombre?: number }[] };
}

/** Ce qui part au serveur : aucune écriture, aucun libellé d'écriture, aucune pièce. */
export function preparerImportFec(analyse: AnalyseFec, exercice: { debut: string; fin: string; cloture: boolean }): ImportFecPrepare {
  const comptes = new Set(analyse.balances.map((b) => b.compte));
  return {
    nomFichier: analyse.nomFichier,
    exercice,
    lignes: analyse.balances.map((b) => [b.mois, b.compte, b.debit, b.credit, b.nombreLignes]),
    libelles: Object.fromEntries(Object.entries(analyse.libelles).filter(([compte]) => comptes.has(compte))),
    resume: {
      lignes: analyse.nombreLignes,
      ecritures: analyse.nombreEcritures,
      desequilibrees: analyse.controles.ecrituresDesequilibrees,
      ecrituresDeSolde: analyse.controles.ecrituresDeSoldeExclues,
      resultat: analyse.controles.resultatReconstitue,
      anomalies: analyse.anomalies.map((a) => ({ code: a.code, gravite: a.gravite, nombre: a.nombre })),
    },
  };
}

export const TAILLE_MAX_FICHIER_FEC = 500 * 1024 * 1024;
export const NOMBRE_MAX_LIGNES_IMPORT = 60_000;

/** Contrôle serveur : le navigateur n'est pas cru sur parole. Renvoie l'erreur, ou null. */
export function erreurImportFec(brut: unknown): string | null {
  const p = brut as ImportFecPrepare | null;
  if (!p || typeof p !== "object") return "Import illisible.";
  const e = p.exercice;
  const dateIso = /^\d{4}-\d{2}-\d{2}$/;
  if (!e || typeof e.debut !== "string" || typeof e.fin !== "string" || !dateIso.test(e.debut) || !dateIso.test(e.fin) || e.debut > e.fin) return "Exercice invalide.";
  if (typeof e.cloture !== "boolean") return "Exercice invalide.";
  if (moisEcoules(e.debut, e.fin) > 36) return "Un import couvre 36 mois au plus.";
  if (typeof p.nomFichier !== "string" || p.nomFichier.length > 255) return "Nom de fichier invalide.";
  if (!Array.isArray(p.lignes) || p.lignes.length === 0) return "L'import ne contient aucune balance.";
  if (p.lignes.length > NOMBRE_MAX_LIGNES_IMPORT) return "L'import dépasse la taille maximale.";
  let debit = 0;
  let credit = 0;
  const vus = new Set<string>();
  for (const ligne of p.lignes) {
    if (!Array.isArray(ligne) || ligne.length !== 5) return "Balance illisible.";
    const [mois, compte, d, c, n] = ligne;
    if (typeof mois !== "string" || !/^\d{4}-(0[1-9]|1[0-2])$/.test(mois)) return "Mois invalide.";
    if (mois < e.debut.slice(0, 7) || mois > e.fin.slice(0, 7)) return "Des écritures sont datées hors de l'exercice indiqué.";
    if (typeof compte !== "string" || normaliserCompte(compte) !== compte) return "Numéro de compte invalide.";
    if (typeof d !== "number" || typeof c !== "number" || typeof n !== "number" || !Number.isFinite(d) || !Number.isFinite(c) || !Number.isInteger(n) || n < 0) return "Montant invalide.";
    const cle = `${mois}|${compte}`;
    if (vus.has(cle)) return "Un compte figure deux fois pour un même mois.";
    vus.add(cle);
    debit += Math.round(d * 100);
    credit += Math.round(c * 100);
  }
  if (debit !== credit) return "Le total des débits diffère du total des crédits.";
  return null;
}

/** Soldes prêts pour le moteur : le même format que la balance de l'API Pennylane. */
export function soldesDepuisImportFec(lignes: ImportFecPrepare["lignes"]): SoldeCompte[] {
  return lignes.map(([mois, compte, debit, credit, nombreLignes]) => ({ compte, mois, debit, credit, nombreLignes }));
}

/** Empreinte de ce qui est importé, indépendante de l'encodage et de l'ordre des lignes du fichier. */
export function contenuCanonique(p: Pick<ImportFecPrepare, "exercice" | "lignes">): string {
  const lignes = [...p.lignes].map(([m, c, d, cr]) => `${m}|${c}|${Math.round(d * 100)}|${Math.round(cr * 100)}`).sort();
  return `${p.exercice.debut}|${p.exercice.fin}\n${lignes.join("\n")}`;
}
