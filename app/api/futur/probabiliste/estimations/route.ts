import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin, supabaseAdminConfigured } from "@/lib/supabaseAdmin";
import { accesPrevisionProbabiliste } from "@/lib/probaAcces";
import { calibrerCompte } from "@/lib/probaServeur";
import { estimerDates } from "@/lib/probaEstimation";
import { ReponseEstimations, validerFacturesEnRetard } from "@/lib/probaApi";
import { dateDansFuseau } from "@/lib/fiabiliteProjection";

// Dates d'encaissement estimées des factures clients en retard (offre Pilotage, revérifiée à chaque
// appel) : à partir de l'historique de paiement de la SEULE société de l'utilisateur, sachant que
// chaque facture est encore impayée aujourd'hui (lib/probaEstimation.ts). Rien n'est enregistré :
// ni la date saisie ni l'échéance de la facture ne sont modifiées.

export const dynamic = "force-dynamic";
export const fetchCache = "force-no-store";
export const maxDuration = 30;

export async function POST(req: NextRequest) {
  if (!supabaseAdminConfigured || !supabaseAdmin) {
    return NextResponse.json({ error: "Configuration serveur incomplète." }, { status: 500 });
  }
  const acces = await accesPrevisionProbabiliste(req, "futur/probabiliste/estimations");
  if (!acces.ok) return acces.reponse;
  let corps: unknown;
  try {
    corps = await req.json();
  } catch {
    return NextResponse.json({ error: "Requête invalide." }, { status: 400 });
  }
  const dateDepart = (corps as { dateDepart?: unknown } | null)?.dateDepart;
  const validation = validerFacturesEnRetard(corps);
  if (!validation.ok) return NextResponse.json({ error: validation.erreur }, { status: 400 });
  // Date d'analyse : celle de la projection (date du relevé), sinon aujourd'hui.
  const depart = typeof dateDepart === "string" && /^\d{4}-\d{2}-\d{2}$/.test(dateDepart) ? dateDepart : dateDansFuseau(new Date());
  try {
    const debut = Date.now();
    const { modeles } = await calibrerCompte(supabaseAdmin, acces.companyId, "futur/probabiliste/estimations");
    const estimations = estimerDates(validation.valeur, modeles.client, depart);
    console.log(
      `[futur/probabiliste/estimations] company=${acces.companyId} factures=${estimations.length} estimees=${estimations.filter((e) => e.statut === "estimee").length} duree_ms=${Date.now() - debut}`
    );
    const reponse: ReponseEstimations = { estimations };
    return NextResponse.json(reponse);
  } catch (erreur) {
    console.error(`[futur/probabiliste/estimations] échec company=${acces.companyId}`, erreur);
    return NextResponse.json({ error: "Les dates des factures en retard n'ont pas pu être estimées." }, { status: 500 });
  }
}
