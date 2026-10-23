import { NextRequest, NextResponse } from "next/server";
import type { SupabaseClient } from "@supabase/supabase-js";
import { supabaseAdmin, supabaseAdminConfigured } from "@/lib/supabaseAdmin";
import { chargerCorrespondanceServeur, chargerDonneesPrevisionServeur } from "@/lib/supabaseRepository";
import { chargerExercice } from "@/lib/pastTransactionsRepository";
import { resoudreRemplacements } from "@/lib/rapprochementChargesFixes";
import { ajouterJours, parseDateISO, toISODate } from "@/lib/dates";
import {
  construireReference,
  dateDansFuseau,
  deciderCapture,
  instantCloture,
  PeriodeFiabilite,
  periodeContenant,
  TypePeriode,
  VERSION_MOTEUR_REFERENCE,
} from "@/lib/fiabiliteProjection";

// Capture des prévisions de référence (lib/fiabiliteProjection.ts), sans navigateur : appelée chaque
// jour par la planification Vercel (vercel.json, « crons »), avec l'en-tête
// Authorization: Bearer <CRON_SECRET> que Vercel ajoute lui-même quand la variable existe.
//
// Pour chaque société et chaque type de période (mois, trimestre) :
//  - la veille du début d'une période (date de Paris) : capture provisoire de la projection ;
//  - après la clôture (minuit, Paris) : la provisoire devient officielle si aucune donnée n'a changé
//    entre sa capture et la clôture ; à défaut, l'état actuel est retenu s'il n'a pas changé depuis
//    la clôture ; sinon, pas de référence (« Prévision de référence indisponible »).
// Idempotent : une référence officielle n'est jamais refaite ni modifiée (contrainte + trigger).

export const dynamic = "force-dynamic";
export const maxDuration = 300;

const TYPES: TypePeriode[] = ["month", "quarter"];
const RETENTION_EVENEMENTS_JOURS = 120;

type Row = Record<string, unknown>;

async function societesInitialisees(admin: SupabaseClient): Promise<string[]> {
  const ids: string[] = [];
  for (let debut = 0; ; debut += 1000) {
    const { data, error } = await admin.from("cash_settings").select("company_id").order("company_id").range(debut, debut + 999);
    if (error) throw error;
    ids.push(...((data ?? []) as Row[]).map((r) => r.company_id as string));
    if ((data ?? []).length < 1000) return ids;
  }
}

async function capturerSociete(admin: SupabaseClient, companyId: string, maintenant: Date) {
  const aujourdhui = dateDansFuseau(maintenant);
  const demain = toISODate(ajouterJours(parseDateISO(aujourdhui), 1));
  const exercice = await chargerExercice(admin, companyId);

  // Périodes concernées : celle qui commence demain (veille au soir), et celle en cours.
  const periodes: PeriodeFiabilite[] = [];
  for (const type of TYPES) {
    const prochaine = periodeContenant(type, demain, exercice);
    if (prochaine.debut === demain) periodes.push(prochaine);
    const courante = periodeContenant(type, aujourdhui, exercice);
    if (courante.debut !== demain) periodes.push(courante);
  }

  const { data: refs, error: erreurRefs } = await admin
    .from("future_forecast_references")
    .select("id, period_kind, period_start, status, captured_at")
    .eq("company_id", companyId)
    .in("period_start", periodes.map((p) => p.debut));
  if (erreurRefs) throw erreurRefs;

  const plusAncienne = new Date(Math.min(...periodes.map((p) => instantCloture(p).getTime())) - 3 * 86_400_000);
  const { data: evenements, error: erreurEvenements } = await admin
    .from("future_change_events")
    .select("changed_at")
    .eq("company_id", companyId)
    .gt("changed_at", plusAncienne.toISOString());
  if (erreurEvenements) throw erreurEvenements;
  const modifications = ((evenements ?? []) as Row[]).map((e) => new Date(e.changed_at as string));

  let donnees: Awaited<ReturnType<typeof chargerDonneesPrevisionServeur>> | null = null;
  let correspondance: Awaited<ReturnType<typeof chargerCorrespondanceServeur>> | null = null;
  const actions: string[] = [];

  for (const periode of periodes) {
    const siennes = ((refs ?? []) as Row[]).filter((r) => r.period_kind === periode.type && r.period_start === periode.debut);
    const provisoire = siennes.find((r) => r.status === "provisional");
    const decision = deciderCapture(
      periode,
      maintenant,
      {
        officielle: siennes.some((r) => r.status === "official"),
        provisoire: provisoire ? { captureLe: new Date(provisoire.captured_at as string) } : null,
      },
      modifications
    );
    actions.push(`${periode.type}:${periode.debut}:${decision.action}`);
    if (decision.action === "rien" || decision.action === "indisponible") continue;

    if (decision.action === "confirmer_provisoire") {
      const { data: copie, error } = await admin.from("future_forecast_references").select("*").eq("id", provisoire!.id).single();
      if (error) throw error;
      const { id: _id, created_at: _cree, status: _statut, ...contenu } = copie as Row;
      const { error: erreurInsertion } = await admin
        .from("future_forecast_references")
        .upsert({ ...contenu, status: "official" }, { onConflict: "company_id,period_kind,period_start,status", ignoreDuplicates: true });
      if (erreurInsertion) throw erreurInsertion;
      continue;
    }

    donnees ??= await chargerDonneesPrevisionServeur(admin, companyId);
    correspondance ??= await chargerCorrespondanceServeur(admin, companyId);
    const { remplacements } = resoudreRemplacements(donnees.liensRapprochement, donnees.chargesFixes, donnees.facturesFournisseurs, parseDateISO(periode.fin));
    const reference = construireReference({ ...donnees, remplacements }, periode, correspondance);
    const ligne = {
      company_id: companyId,
      period_kind: periode.type,
      period_start: periode.debut,
      period_end: periode.fin,
      reference_at: instantCloture(periode).toISOString(),
      captured_at: maintenant.toISOString(),
      status: decision.action === "capturer_provisoire" ? "provisional" : "official",
      capture_mode: decision.action === "capturer_provisoire" ? "before_close" : "after_close_unchanged",
      engine_version: VERSION_MOTEUR_REFERENCE,
      totals: reference.totaux,
      lines: reference.lignes,
      coverage: reference.couverture,
    };
    // Officielle : insérée une seule fois, jamais écrasée. Provisoire : remplacée tant qu'elle n'est pas confirmée.
    const { error } = await admin
      .from("future_forecast_references")
      .upsert(ligne, { onConflict: "company_id,period_kind,period_start,status", ignoreDuplicates: ligne.status === "official" });
    if (error) throw error;
  }
  return actions;
}

export async function GET(req: NextRequest) {
  const secret = process.env.CRON_SECRET;
  if (!secret) {
    console.error("[futur/capture] CRON_SECRET absente : capture refusée");
    return NextResponse.json({ error: "Planification non configurée." }, { status: 500 });
  }
  if (req.headers.get("authorization") !== `Bearer ${secret}`) {
    return NextResponse.json({ error: "Non autorisé." }, { status: 401 });
  }
  if (!supabaseAdminConfigured || !supabaseAdmin) {
    return NextResponse.json({ error: "Configuration serveur incomplète." }, { status: 500 });
  }
  const admin = supabaseAdmin;
  const maintenant = new Date();
  const resultats: { societe: string; actions?: string[]; erreur?: string }[] = [];

  for (const companyId of await societesInitialisees(admin)) {
    try {
      resultats.push({ societe: companyId, actions: await capturerSociete(admin, companyId, maintenant) });
    } catch (erreur) {
      // Une société en erreur n'empêche pas les autres ; la relance du lendemain reprend.
      const code = (erreur as { code?: string } | null)?.code ?? "inconnu";
      console.error(`[futur/capture] company=${companyId} échec code=${code}`, erreur);
      resultats.push({ societe: companyId, erreur: code });
    }
  }

  const { error: erreurPurge } = await admin
    .from("future_change_events")
    .delete()
    .lt("changed_at", new Date(maintenant.getTime() - RETENTION_EVENEMENTS_JOURS * 86_400_000).toISOString());
  if (erreurPurge) console.error(`[futur/capture] purge des événements échouée code=${erreurPurge.code ?? "inconnu"}`);

  console.log(`[futur/capture] ${maintenant.toISOString()} societes=${resultats.length} erreurs=${resultats.filter((r) => r.erreur).length}`);
  return NextResponse.json({ instant: maintenant.toISOString(), resultats });
}
