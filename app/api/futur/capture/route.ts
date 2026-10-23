import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin, supabaseAdminConfigured } from "@/lib/supabaseAdmin";
import { capturerSociete, RETENTION_EVENEMENTS_JOURS, societesInitialisees } from "@/lib/captureReferences";

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
export const fetchCache = "force-no-store";
export const maxDuration = 300;

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
