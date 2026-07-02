import * as XLSX from "xlsx";
import { FactureClient, FactureFournisseur } from "./types";
import { toISODate } from "./dates";

const COLONNES_ATTENDUES = ["type", "facture", "tiers", "montant", "date_echeance", "date_paiement", "litigieuse"];

export interface LigneImportValide {
  ligne: number;
  type: "client" | "fournisseur";
  facture: FactureClient | FactureFournisseur;
}

export interface LigneImportErreur {
  ligne: number;
  motifs: string[];
}

export interface ResultatImport {
  totalLignes: number;
  nombreClients: number;
  nombreFournisseurs: number;
  lignesValides: LigneImportValide[];
  lignesErreur: LigneImportErreur[];
}

export async function lireFichierImport(fichier: File): Promise<Record<string, unknown>[]> {
  const buffer = await fichier.arrayBuffer();
  const classeur = XLSX.read(buffer, { type: "array", cellDates: true });
  const feuille = classeur.Sheets[classeur.SheetNames[0]];
  if (!feuille) return [];
  return XLSX.utils.sheet_to_json<Record<string, unknown>>(feuille, { defval: "" });
}

function normaliserTexte(valeur: unknown): string {
  return String(valeur ?? "").trim();
}

function parserMontant(valeur: unknown): number | null {
  if (typeof valeur === "number") return valeur;
  const texte = normaliserTexte(valeur).replace(/\s/g, "");
  if (!texte) return null;
  const normalise = texte.includes(",") && !texte.includes(".") ? texte.replace(",", ".") : texte;
  const nombre = Number(normalise);
  return Number.isFinite(nombre) ? nombre : null;
}

function parserDate(valeur: unknown): string | null {
  if (valeur instanceof Date) {
    return Number.isNaN(valeur.getTime()) ? null : toISODate(valeur);
  }
  const texte = normaliserTexte(valeur);
  if (!texte) return null;

  const isoMatch = texte.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (isoMatch) {
    const date = new Date(texte + "T00:00:00");
    return Number.isNaN(date.getTime()) ? null : texte;
  }

  const frMatch = texte.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (frMatch) {
    const [, jour, mois, annee] = frMatch;
    const date = new Date(Number(annee), Number(mois) - 1, Number(jour));
    if (Number.isNaN(date.getTime())) return null;
    return toISODate(date);
  }

  return null;
}

function parserLitigieuse(valeur: unknown): boolean {
  const texte = normaliserTexte(valeur).toLowerCase();
  return ["oui", "true", "1", "vrai", "yes", "x"].includes(texte);
}

export function validerLignesImport(lignesBrutes: Record<string, unknown>[]): ResultatImport {
  const lignesValides: LigneImportValide[] = [];
  const lignesErreur: LigneImportErreur[] = [];

  lignesBrutes.forEach((ligneBrute, index) => {
    const ligne = index + 2; // ligne 1 = en-têtes
    const motifs: string[] = [];

    const typeBrut = normaliserTexte(ligneBrute.type).toLowerCase();
    if (typeBrut !== "client" && typeBrut !== "fournisseur") {
      motifs.push('Type invalide (doit être "client" ou "fournisseur")');
    }

    const facture = normaliserTexte(ligneBrute.facture);
    if (!facture) motifs.push("Facture manquante");

    const tiers = normaliserTexte(ligneBrute.tiers);
    if (!tiers) motifs.push("Tiers manquant");

    const montant = parserMontant(ligneBrute.montant);
    if (montant === null || montant <= 0) motifs.push("Montant invalide (doit être un nombre positif)");

    const dateEcheance = parserDate(ligneBrute.date_echeance);
    if (!dateEcheance) motifs.push("Date d'échéance invalide");

    const datePaiement = parserDate(ligneBrute.date_paiement);
    if (!datePaiement) motifs.push("Date de paiement invalide");

    if (motifs.length > 0) {
      lignesErreur.push({ ligne, motifs });
      return;
    }

    const litigieuse = parserLitigieuse(ligneBrute.litigieuse);

    if (typeBrut === "client") {
      lignesValides.push({
        ligne,
        type: "client",
        facture: {
          id: crypto.randomUUID(),
          facture,
          client: tiers,
          montant: montant as number,
          dateEcheance: dateEcheance as string,
          dateEncaissementAnticipee: datePaiement as string,
          litigieuse,
        },
      });
    } else {
      lignesValides.push({
        ligne,
        type: "fournisseur",
        facture: {
          id: crypto.randomUUID(),
          facture,
          fournisseur: tiers,
          montant: montant as number,
          dateEcheance: dateEcheance as string,
          datePaiementPrevue: datePaiement as string,
          litigieuse,
        },
      });
    }
  });

  return {
    totalLignes: lignesBrutes.length,
    nombreClients: lignesValides.filter((l) => l.type === "client").length,
    nombreFournisseurs: lignesValides.filter((l) => l.type === "fournisseur").length,
    lignesValides,
    lignesErreur,
  };
}

export function genererModeleXLSX(): Blob {
  const exemple1 = ["client", "FAC-001", "Client A", 15000, "2026-07-15", "2026-07-20", "false"];
  const exemple2 = ["fournisseur", "FOU-001", "Fournisseur X", 12000, "2026-07-18", "2026-07-18", "false"];

  const feuille = XLSX.utils.aoa_to_sheet([COLONNES_ATTENDUES, exemple1, exemple2]);
  const classeur = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(classeur, feuille, "Import");

  const contenu = XLSX.write(classeur, { bookType: "xlsx", type: "array" });
  return new Blob([contenu], {
    type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  });
}
