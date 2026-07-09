import { formatDateCourte } from "./dates";
import { AutreDepense, ChargeFixe, FactureClient, FactureFournisseur, Financement, RentreeReguliere } from "./types";

/** Minuscules et sans accents, pour une recherche insensible à la casse et aux accents. */
export function normaliserRecherche(texte: string): string {
  return texte
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .trim();
}

function correspond(recherche: string, ...champs: (string | number | null | undefined)[]): boolean {
  const terme = normaliserRecherche(recherche);
  if (!terme) return true;
  return champs.some((champ) => {
    if (champ === null || champ === undefined || champ === "") return false;
    return normaliserRecherche(String(champ)).includes(terme);
  });
}

export function filtrerFacturesClients(factures: FactureClient[], recherche: string): FactureClient[] {
  return factures.filter((f) =>
    correspond(
      recherche,
      f.facture,
      f.client,
      f.montant,
      formatDateCourte(f.dateEcheance),
      formatDateCourte(f.dateEncaissementAnticipee)
    )
  );
}

export function filtrerFacturesFournisseurs(
  factures: FactureFournisseur[],
  recherche: string
): FactureFournisseur[] {
  return factures.filter((f) =>
    correspond(
      recherche,
      f.facture,
      f.fournisseur,
      f.montant,
      formatDateCourte(f.dateEcheance),
      formatDateCourte(f.datePaiementPrevue)
    )
  );
}

export function filtrerChargesFixes(charges: ChargeFixe[], recherche: string): ChargeFixe[] {
  return charges.filter((c) => correspond(recherche, c.libelle, c.montant, c.recurrence));
}

export function filtrerRentreesRegulieres(rentrees: RentreeReguliere[], recherche: string): RentreeReguliere[] {
  return rentrees.filter((r) => correspond(recherche, r.libelle, r.montant, r.frequence));
}

export function filtrerAutresDepenses(depenses: AutreDepense[], recherche: string): AutreDepense[] {
  return depenses.filter((d) => correspond(recherche, d.libelle, d.montant, d.type));
}

export function filtrerFinancements(financements: Financement[], recherche: string): Financement[] {
  return financements.filter((f) =>
    correspond(recherche, f.libelle, f.montant, formatDateCourte(f.dateEncaissementPrevue))
  );
}
