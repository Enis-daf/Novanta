import type { SupabaseClient } from "@supabase/supabase-js";
import { TypeFactureBfr } from "./pastBfr";
import { Row, TAILLE_LOT, VERS_BASE, versLigneStockee } from "./pastBfrRepository";
import { cleFacture, DepotFacturesBfr, LigneStockee, operationSupabase } from "./pastBfrSync";

/*
 * Dépôt serveur des factures BFR (past_bfr_invoices), pour la route /api/passe/bfr : client admin,
 * toutes les requêtes bornées à l'organisation, chaque opération comptée dans les mesures.
 */

const COLONNES_FAITS = "*";

/** Dépôt des factures BFR d'une organisation (client admin, route serveur seulement). */
export function depotFacturesBfr(admin: SupabaseClient, organizationId: string): DepotFacturesBfr {
  const lire = async (filtrer: (requete: ReturnType<typeof requeteBase>) => ReturnType<typeof requeteBase>, limite = Infinity) => {
    const lignes: LigneStockee[] = [];
    for (let debut = 0; debut < limite; debut += 1000) {
      const taille = Math.min(1000, limite - debut);
      const { data, error } = await operationSupabase(() => filtrer(requeteBase()).order("invoice_type").order("pennylane_id").range(debut, debut + taille - 1));
      if (error) throw error;
      const page = (data ?? []) as Row[];
      lignes.push(...page.map(versLigneStockee));
      if (page.length < taille) break;
    }
    return lignes;
  };
  const requeteBase = () => admin.from("past_bfr_invoices").select(COLONNES_FAITS).eq("organization_id", organizationId);

  return {
    async charger() {
      const lignes = await lire((r) => r);
      return new Map(lignes.map((l) => [cleFacture(l.facture.type, l.facture.pennylaneId), l]));
    },
    async ecrire(lignes, syncedAt) {
      for (let i = 0; i < lignes.length; i += TAILLE_LOT) {
        const lot = lignes.slice(i, i + TAILLE_LOT).map(({ facture: f, pennylaneUpdatedAt, reglements }) => ({
          organization_id: organizationId,
          invoice_type: VERS_BASE[f.type],
          pennylane_id: f.pennylaneId,
          invoice_number: f.numero,
          party_label: f.tiers,
          issue_date: f.dateEmission,
          due_date: f.echeance,
          currency: f.devise,
          amount_incl_tax: f.montantTtc,
          amount_excl_tax: f.montantHt,
          remaining_incl_tax: f.resteTtc,
          remaining_excl_tax: f.resteHt,
          exclusion: f.exclusion,
          credited_pennylane_id: f.factureAvoireeId,
          settlements: reglements,
          pennylane_updated_at: pennylaneUpdatedAt,
          synced_at: syncedAt,
        }));
        const { error } = await operationSupabase(() => admin.from("past_bfr_invoices").upsert(lot, { onConflict: "organization_id,invoice_type,pennylane_id" }));
        if (error) throw error;
      }
    },
    async supprimer(cles) {
      for (const type of ["client", "fournisseur"] as TypeFactureBfr[]) {
        const ids = cles.filter((c) => c.type === type).map((c) => c.pennylaneId);
        for (let i = 0; i < ids.length; i += TAILLE_LOT) {
          const { error } = await operationSupabase(() =>
            admin.from("past_bfr_invoices").delete().eq("organization_id", organizationId).eq("invoice_type", VERS_BASE[type]).in("pennylane_id", ids.slice(i, i + TAILLE_LOT))
          );
          if (error) throw error;
        }
      }
    },
    async marquerSynchronisees(syncedAt) {
      const { error } = await operationSupabase(() => admin.from("past_bfr_invoices").update({ synced_at: syncedAt }).eq("organization_id", organizationId));
      if (error) throw error;
    },
    aDater(limite) {
      return lire((r) => r.eq("settlements->>etat", "a_dater"), limite);
    },
    async compterADater() {
      const { count, error } = await operationSupabase(() =>
        admin.from("past_bfr_invoices").select("pennylane_id", { count: "exact", head: true }).eq("organization_id", organizationId).eq("settlements->>etat", "a_dater")
      );
      if (error) throw error;
      return count ?? 0;
    },
  };
}

