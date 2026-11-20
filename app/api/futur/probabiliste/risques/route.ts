import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin, supabaseAdminConfigured } from "@/lib/supabaseAdmin";
import { accesPrevisionProbabiliste } from "@/lib/probaAcces";
import { calibrerCompte } from "@/lib/probaServeur";
import { analyserRisques } from "@/lib/probaRisques";
import { ReponseRisques, validerRequeteRisques } from "@/lib/probaApi";

// Gestion des risques — Encaissements critiques (offre Pilotage, revérifiée à chaque appel).
// Le navigateur envoie les échéances de sa projection et l'identité des factures à analyser ; ici :
// calibration des retards de la société de l'utilisateur (plausibilité), puis tests de sensibilité
// sur la trajectoire de référence (lib/probaRisques.ts). Rien n'est enregistré : ni date, ni
// hypothèse. Contrairement à la prévision probabiliste, une hypothèse « À renseigner » ne bloque pas
// l'analyse : la référence ne dépend que des montants et dates prévus.

export const dynamic = "force-dynamic";
export const fetchCache = "force-no-store";
export const maxDuration = 30;

export async function POST(req: NextRequest) {
  if (!supabaseAdminConfigured || !supabaseAdmin) {
    return NextResponse.json({ error: "Configuration serveur incomplète." }, { status: 500 });
  }
  const admin = supabaseAdmin;
  const acces = await accesPrevisionProbabiliste(req, "futur/probabiliste/risques");
  if (!acces.ok) return acces.reponse;
  const { companyId } = acces;

  let corps: unknown;
  try {
    corps = await req.json();
  } catch {
    return NextResponse.json({ error: "Requête invalide." }, { status: 400 });
  }
  const validation = validerRequeteRisques(corps);
  if (!validation.ok) return NextResponse.json({ error: validation.erreur }, { status: 400 });
  const requete = validation.valeur;

  try {
    const debut = Date.now();
    const { modeles } = await calibrerCompte(admin, companyId, "futur/probabiliste/risques");
    const resultat = analyserRisques({ ...requete, modeles }, modeles.client);
    const dureeMs = Date.now() - debut;
    const { couverture } = resultat;
    console.log(
      `[futur/probabiliste/risques] company=${companyId} factures=${couverture.facturesAnalysees} paires=${couverture.pairesEvaluees}/${couverture.pairesPossibles} ecartees=${couverture.pairesEcarteesSansRisque} methode=${couverture.methode} partielle=${couverture.partielle} groupes=${resultat.groupes.length} duree_ms=${dureeMs}`
    );
    const reponse: ReponseRisques = {
      ...resultat,
      parametres: { dateDepart: requete.dateDepart, horizonJours: requete.horizonJours, soldeInitial: requete.soldeInitial, dureeMs },
    };
    return NextResponse.json(reponse);
  } catch (erreur) {
    console.error(`[futur/probabiliste/risques] échec du calcul company=${companyId}`, erreur);
    return NextResponse.json({ error: "L'analyse des encaissements critiques n'a pas pu être calculée." }, { status: 500 });
  }
}
