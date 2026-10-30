import { PennylaneCredentialProvider } from "./pennylaneCredentialProvider";
import { periodeEnMoisEntiers } from "./comptaPnl";
import { ExerciceComptable } from "./comptaExercices";
import { listFiscalYears, listLedgerAccounts, listTrialBalance, PennylaneFiscalYearRaw, PennylaneLedgerAccountRaw, PennylaneTrialBalanceRaw } from "./pennylaneClient";
import { CompteSource, LectureBalance, SoldeSource, SourceComptable } from "./comptaSource";

/**
 * Source réelle : plan de comptes et balance mensuelle Pennylane, en lecture seule. DÉSACTIVÉE par défaut
 * (lib/featureFlags.ts::synchroComptableReelleActive). Champs observés lors du diagnostic réel du
 * 30/10/2026, sur un seul dossier : voir docs/pnl-comptable-pennylane.md.
 *
 * La balance reprend toutes les écritures, quel que soit leur statut (sur le dossier testé, tous les
 * produits et charges du mois étaient en attente de validation) : le P&L le dit à l'écran.
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

export function depuisExerciceBrut(brut: PennylaneFiscalYearRaw): ExerciceComptable {
  const date = /^\d{4}-\d{2}-\d{2}/;
  if (typeof brut.start !== "string" || !date.test(brut.start) || typeof brut.finish !== "string" || !date.test(brut.finish)) throw new FormatComptableInattendu("Exercice sans dates lisibles.");
  return { idSource: String(brut.id), debut: brut.start.slice(0, 10), fin: brut.finish.slice(0, 10), statut: brut.status ?? null };
}

export function depuisSoldeBrut(brut: PennylaneTrialBalanceRaw): SoldeSource {
  if (typeof brut.number !== "string" || brut.number === "") throw new FormatComptableInattendu("Ligne de balance sans numéro de compte.");
  return { compte: brut.number, libelle: brut.label ?? null, debit: montant(brut.debits, "debits"), credit: montant(brut.credits, "credits") };
}

/**
 * Un même numéro peut exister sous plusieurs identifiants (observé sur 41 numéros du dossier testé) : il
 * n'en reste qu'un par numéro, le compte actif de préférence. La table impose un compte par numéro.
 */
export function comptesParNumero(comptes: CompteSource[]): CompteSource[] {
  const parNumero = new Map<string, CompteSource>();
  for (const compte of comptes) {
    const connu = parNumero.get(compte.numero);
    if (!connu || (!connu.actif && compte.actif)) parNumero.set(compte.numero, compte);
  }
  return [...parNumero.values()];
}

export function sourcePennylane(credentialProvider: PennylaneCredentialProvider): SourceComptable {
  return {
    nom: "pennylane",
    async lireExercices() {
      return (await listFiscalYears(credentialProvider)).map(depuisExerciceBrut);
    },
    async lireComptes() {
      return (await listLedgerAccounts(credentialProvider)).map(depuisCompteBrut);
    },
    async lireBalanceDuMois(mois: string): Promise<LectureBalance> {
      const { debut, fin } = periodeEnMoisEntiers({ debut: `${mois}-01`, fin: `${mois}-01` });
      const { soldes, complete } = await listTrialBalance(credentialProvider, debut, fin);
      return { soldes: soldes.map(depuisSoldeBrut), complete };
    },
  };
}
