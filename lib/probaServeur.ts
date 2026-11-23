import type { SupabaseClient } from "@supabase/supabase-js";
import { chargerFacturesBfr } from "./pastBfrRepository";
import { chargerFacturesPayeesFutur, enregistrerProfilSiChange } from "./probaRepository";
import { construireHistorique } from "./probaHistorique";
import { calibrerModele, ModeleRetards, ProfilPaiement, profilPaiement } from "./probaCalibration";
import { dateDansFuseau } from "./fiabiliteProjection";

/**
 * Calibration des retards de paiement d'UNE société (routes /api/futur/probabiliste/*) : historique
 * de ses seules factures, modèles clients / fournisseurs, profil de paiement enregistré s'il a
 * changé. Jamais les données d'une autre société : companyId vient toujours de l'utilisateur connecté.
 */
export interface CalibrationCompte {
  modeles: { client: ModeleRetards; fournisseur: ModeleRetards };
  profils: { client: ProfilPaiement; fournisseur: ProfilPaiement };
  historique: { client: number; fournisseur: number };
}

export async function calibrerCompte(admin: SupabaseClient, companyId: string, journal: string): Promise<CalibrationCompte> {
  const aujourdhui = dateDansFuseau(new Date());
  const [{ factures }, futur] = await Promise.all([chargerFacturesBfr(admin, companyId), chargerFacturesPayeesFutur(admin, companyId)]);
  const historique = construireHistorique(factures, futur, aujourdhui);
  const modeles = {
    client: calibrerModele(historique.client, "client", aujourdhui),
    fournisseur: calibrerModele(historique.fournisseur, "fournisseur", aujourdhui),
  };
  const profils = {
    client: profilPaiement(historique.client, "client", aujourdhui),
    fournisseur: profilPaiement(historique.fournisseur, "fournisseur", aujourdhui),
  };
  // Recalibration enregistrée au fil de l'eau ; son échec ne prive jamais l'utilisateur du calcul.
  await Promise.all(
    [profils.client, profils.fournisseur].map((p) =>
      enregistrerProfilSiChange(admin, companyId, p).catch((erreur) => console.error(`[${journal}] profil ${p.cote} non enregistré`, erreur))
    )
  );
  return { modeles, profils, historique: { client: historique.client.length, fournisseur: historique.fournisseur.length } };
}
