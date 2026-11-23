import { NextRequest, NextResponse } from "next/server";
import { accesPrevisionProbabiliste } from "@/lib/probaAcces";
import { chargerHypotheses, enregistrerHypothese, estColonneAbsente, estTableAbsente } from "@/lib/probaRepository";
import { validerHypothese } from "@/lib/probaApi";

// Hypothèses de la prévision probabiliste (probabilité, fiabilité de la date, dépendance), ligne
// par ligne. Offre Pilotage revérifiée à chaque appel ; lecture et écriture avec le client de
// l'utilisateur (RLS : sa propre société).

export const dynamic = "force-dynamic";
export const fetchCache = "force-no-store";

export async function GET(req: NextRequest) {
  const acces = await accesPrevisionProbabiliste(req, "futur/probabiliste/hypotheses");
  if (!acces.ok) return acces.reponse;
  try {
    return NextResponse.json({ hypotheses: await chargerHypotheses(acces.supabase, acces.companyId) });
  } catch (erreur) {
    console.error(`[futur/probabiliste/hypotheses] lecture échouée company=${acces.companyId}`, erreur);
    return NextResponse.json({ error: "Hypothèses illisibles." }, { status: 500 });
  }
}

export async function PUT(req: NextRequest) {
  const acces = await accesPrevisionProbabiliste(req, "futur/probabiliste/hypotheses");
  if (!acces.ok) return acces.reponse;
  let corps: unknown;
  try {
    corps = await req.json();
  } catch {
    return NextResponse.json({ error: "Requête invalide." }, { status: 400 });
  }
  const validation = validerHypothese(corps);
  if (!validation.ok) return NextResponse.json({ error: validation.erreur }, { status: 400 });
  try {
    await enregistrerHypothese(acces.supabase, acces.companyId, validation.valeur);
    return NextResponse.json({ ok: true });
  } catch (erreur) {
    if (estTableAbsente(erreur as { code?: string }) || estColonneAbsente(erreur as { code?: string })) {
      return NextResponse.json({ error: "Enregistrement indisponible : la base n'est pas encore à jour." }, { status: 503 });
    }
    console.error(`[futur/probabiliste/hypotheses] écriture échouée company=${acces.companyId}`, erreur);
    return NextResponse.json({ error: "L'hypothèse n'a pas pu être enregistrée." }, { status: 500 });
  }
}
