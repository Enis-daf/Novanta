import { PennylaneCredentialProvider } from "./pennylaneCredentialProvider";
import { listLedgerAccounts, listLedgerEntryLines, PennylaneLedgerAccountRaw, PennylaneLedgerEntryLineRaw } from "./pennylaneClient";
import { CompteSource, LecturePeriode, LigneSource, SourceComptable } from "./comptaSource";
import { Periode } from "./pastTransactions";

/**
 * Source réelle : comptes et lignes d'écriture Pennylane, en lecture seule. DÉSACTIVÉE par défaut
 * (lib/featureFlags.ts::synchroComptableReelleActive) et jamais exécutée contre une société réelle à ce
 * jour. Elle ne lit que les champs décrits par la documentation officielle (getLedgerAccounts,
 * getLedgerEntryLines) ; ce que Pennylane doit encore confirmer est listé dans
 * docs/pnl-comptable-pennylane.md.
 *
 * La documentation ne décrit aucun statut sur une ligne d'écriture : aucune n'est donc exclue ici.
 */

export class FormatComptableInattendu extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FormatComptableInattendu";
  }
}

function montant(valeur: unknown, champ: string): number {
  const nombre = typeof valeur === "string" && valeur.trim() !== "" ? Number(valeur) : NaN;
  if (!Number.isFinite(nombre)) throw new FormatComptableInattendu(`Champ ${champ} illisible sur une ligne d'écriture.`);
  return nombre;
}

export function depuisCompteBrut(brut: PennylaneLedgerAccountRaw): CompteSource {
  if (typeof brut.number !== "string" || brut.number === "") throw new FormatComptableInattendu("Compte sans numéro.");
  return {
    idSource: String(brut.id),
    numero: brut.number,
    libelle: brut.label ?? "",
    type: brut.type ?? null,
    actif: brut.enabled !== false,
  };
}

export function depuisLigneBrute(brut: PennylaneLedgerEntryLineRaw): LigneSource {
  const numero = brut.ledger_account?.number;
  if (typeof numero !== "string" || numero === "") throw new FormatComptableInattendu("Ligne d'écriture sans numéro de compte.");
  if (typeof brut.date !== "string" || !/^\d{4}-\d{2}-\d{2}/.test(brut.date)) throw new FormatComptableInattendu("Ligne d'écriture sans date.");
  return {
    idSource: String(brut.id),
    idEcriture: brut.ledger_entry?.id !== undefined ? String(brut.ledger_entry.id) : null,
    idJournal: brut.journal?.id !== undefined ? String(brut.journal.id) : null,
    compte: numero,
    date: brut.date.slice(0, 10),
    debit: montant(brut.debit, "debit"),
    credit: montant(brut.credit, "credit"),
    libelle: brut.label ?? null,
    statutSource: null,
    creeeLe: brut.created_at ?? null,
    modifieeLe: brut.updated_at ?? null,
  };
}

export function sourcePennylane(credentialProvider: PennylaneCredentialProvider): SourceComptable {
  return {
    nom: "pennylane",
    async lireComptes() {
      return (await listLedgerAccounts(credentialProvider)).map(depuisCompteBrut);
    },
    async lirePeriode(periode: Periode): Promise<LecturePeriode> {
      const { lignes, complete } = await listLedgerEntryLines(credentialProvider, periode.debut, periode.fin);
      return { lignes: lignes.map(depuisLigneBrute), complete };
    },
  };
}
