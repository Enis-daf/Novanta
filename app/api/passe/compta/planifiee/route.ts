import type { SupabaseClient } from "@supabase/supabase-js";
import { NextRequest, NextResponse } from "next/server";
import { declencheurPlanifie } from "@/lib/comptaExercices";
import { sourcePennylane } from "@/lib/comptaPennylaneAdapter";
import { chargerDerniereLectureComplete, depotSupabase } from "@/lib/comptaRepository";
import { synchroniserSociete } from "@/lib/comptaSynchro";
import { pnlComptableActif, synchroComptableReelleActive } from "@/lib/featureFlags";
import { chargerDroitsOrganisation } from "@/lib/offres";
import { moduleActifPourOrganisation } from "@/lib/organizationModules";
import { limiteurDebit } from "@/lib/pastBfrSync";
import { CompanyApiTokenCredentialProvider } from "@/lib/pennylaneCredentialProvider";
import { obtenirTokenPennylane } from "@/lib/pennylaneRepository";
import { supabaseAdmin, supabaseAdminConfigured } from "@/lib/supabaseAdmin";

// Synchronisation comptable sans navigateur : appelée chaque jour par la planification Vercel (vercel.json),
// comme /api/futur/capture, avec l'en-tête Authorization: Bearer <CRON_SECRET>. Chaque société reçoit un passage
// quotidien, ou hebdomadaire si sa dernière lecture complète date de plus de 7 jours : une seule entrée de
// planification, et un passage manqué se rattrape le lendemain.
//
// Sans NOVANTA_COMPTA_SYNC_REELLE et NEXT_PUBLIC_NOVANTA_PNL_COMPTABLE, la route ne lit rien.

export const dynamic = "force-dynamic";
export const fetchCache = "force-no-store";
export const maxDuration = 300;

// Marge avant la durée maximale : les sociétés non traitées passent au tour suivant.
const BUDGET_MS = 270_000;

/** Sociétés connectées à Pennylane, ayant accès, le module Passé et la capacité du P&L comptable. */
async function societesEligibles(admin: SupabaseClient): Promise<string[]> {
  const eligibles: string[] = [];
  for (let debut = 0; ; debut += 1000) {
    const { data, error } = await admin.from("pennylane_connections").select("company_id").eq("status", "connected").order("company_id").range(debut, debut + 999);
    if (error) throw error;
    for (const { company_id: id } of (data ?? []) as { company_id: string }[]) {
      try {
        const { data: societe, error: erreurSociete } = await admin.from("companies").select("access_enabled").eq("id", id).maybeSingle();
        if (erreurSociete || !societe || societe.access_enabled === false) continue;
        if (!(await moduleActifPourOrganisation(admin, id, "past"))) continue;
        if ((await chargerDroitsOrganisation(admin, id)).capacites.canViewAccountingPnl) eligibles.push(id);
      } catch {
        // Fail-closed : un droit illisible n'ouvre pas la lecture comptable.
        console.error(`[passe/compta/planifiee] droits illisibles company=${id}`);
      }
    }
    if ((data ?? []).length < 1000) return eligibles;
  }
}

export async function GET(req: NextRequest) {
  const secret = process.env.CRON_SECRET;
  if (!secret) {
    console.error("[passe/compta/planifiee] CRON_SECRET absente : synchronisation refusée");
    return NextResponse.json({ error: "Planification non configurée." }, { status: 500 });
  }
  if (req.headers.get("authorization") !== `Bearer ${secret}`) return NextResponse.json({ error: "Non autorisé." }, { status: 401 });
  if (!pnlComptableActif() || !synchroComptableReelleActive()) return NextResponse.json({ desactivee: true });
  if (!supabaseAdminConfigured || !supabaseAdmin) return NextResponse.json({ error: "Configuration serveur incomplète." }, { status: 500 });
  const admin = supabaseAdmin;
  const maintenant = new Date();
  const debut = Date.now();
  const resultats: { societe: string; declencheur?: string; statut: string; actualises?: number; demandes?: number }[] = [];

  const societes = await societesEligibles(admin);
  // Les plus anciennes lectures d'abord : une société reportée par le budget passe en tête au tour suivant.
  const parAnciennete = await Promise.all(societes.map(async (id) => ({ id, derniere: await chargerDerniereLectureComplete(admin, id).catch(() => null) })));
  parAnciennete.sort((a, b) => (a.derniere ?? "").localeCompare(b.derniere ?? ""));

  let reportees = 0;
  for (const { id, derniere } of parAnciennete) {
    if (Date.now() - debut > BUDGET_MS) {
      reportees += 1;
      continue;
    }
    // Une société en erreur n'empêche pas les autres.
    try {
      const token = await obtenirTokenPennylane(admin, id);
      if (!token) continue;
      const declencheur = declencheurPlanifie(derniere, maintenant);
      const resultat = await synchroniserSociete(sourcePennylane(new CompanyApiTokenCredentialProvider(token)), depotSupabase(admin, id, "pennylane"), {
        declencheur,
        aujourdhui: maintenant.toISOString().slice(0, 10),
        reserver: limiteurDebit(20, 5000),
      });
      resultats.push(resultat.lancee ? { societe: id, declencheur, statut: resultat.bilan.statut, demandes: resultat.bilan.moisDemandes, actualises: resultat.bilan.moisActualises } : { societe: id, declencheur, statut: resultat.raison });
    } catch (erreur) {
      const code = (erreur as { code?: string } | null)?.code ?? "inconnu";
      console.error(`[passe/compta/planifiee] company=${id} code=${code}`);
      resultats.push({ societe: id, statut: "erreur" });
    }
  }
  console.log(`[passe/compta/planifiee] societes=${resultats.length} reportees=${reportees} erreurs=${resultats.filter((r) => r.statut === "erreur" || r.statut === "error").length}`);
  return NextResponse.json({ instant: maintenant.toISOString(), resultats, reportees });
}
