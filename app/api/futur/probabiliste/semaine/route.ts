import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin, supabaseAdminConfigured } from "@/lib/supabaseAdmin";
import { accesPrevisionProbabiliste } from "@/lib/probaAcces";
import { calibrerCompte } from "@/lib/probaServeur";
import { analyserSemaine, testerDecalage } from "@/lib/probaSemaine";
import { NOMBRE_SIMULATIONS_PAR_DEFAUT } from "@/lib/probaSimulation";
import { GRAINE_PAR_DEFAUT } from "@/lib/probaAlea";
import { ReponseSemaine, validerRequeteSemaine } from "@/lib/probaApi";
import { completudeMoteur } from "@/lib/probaEcran";
import { decalerDateISO } from "@/lib/dates";

// Encaissements à sécuriser (offre Pilotage, revérifiée à chaque appel). Mêmes données, même
// calibration et même graine que la prévision (/api/futur/probabiliste) : les simulations analysées
// sont exactement celles des pourcentages affichés. Aucune simulation n'est stockée : celles qui
// comptent sont rejouées à partir de l'état du générateur (lib/probaSemaine.ts). Rien n'est
// enregistré, ni date ni hypothèse, y compris pour un test de décalage.

export const dynamic = "force-dynamic";
export const fetchCache = "force-no-store";
export const maxDuration = 30;

export async function POST(req: NextRequest) {
  if (!supabaseAdminConfigured || !supabaseAdmin) {
    return NextResponse.json({ error: "Configuration serveur incomplète." }, { status: 500 });
  }
  const admin = supabaseAdmin;
  const acces = await accesPrevisionProbabiliste(req, "futur/probabiliste/semaine");
  if (!acces.ok) return acces.reponse;
  const { companyId } = acces;

  let corps: unknown;
  try {
    corps = await req.json();
  } catch {
    return NextResponse.json({ error: "Requête invalide." }, { status: 400 });
  }
  const validation = validerRequeteSemaine(corps);
  if (!validation.ok) return NextResponse.json({ error: validation.erreur }, { status: 400 });
  const requete = validation.valeur;
  // Même règle que la prévision : pas de Monte Carlo tant qu'une hypothèse importante manque.
  const etat = completudeMoteur(requete.lignes, requete.evenements, decalerDateISO(requete.dateDepart, requete.horizonJours));
  if (etat.bloquee) {
    return NextResponse.json({ error: "Des hypothèses importantes doivent être renseignées.", code: "hypotheses_a_renseigner" }, { status: 409 });
  }

  try {
    const debut = Date.now();
    const { modeles } = await calibrerCompte(admin, companyId, "futur/probabiliste/semaine");
    const historiqueMs = Date.now() - debut;
    const params = {
      ...requete,
      modeles,
      graine: requete.graine ?? GRAINE_PAR_DEFAUT,
      nombreSimulations: requete.nombreSimulations ?? NOMBRE_SIMULATIONS_PAR_DEFAUT,
    };
    if (requete.test) {
      const resultat = testerDecalage(params, requete.test.simulation, requete.test.cleLigne, requete.test.date, requete.semaine);
      return NextResponse.json(resultat);
    }
    const resultat = analyserSemaine(params);
    const dureeRouteMs = Date.now() - debut;
    console.log(
      `[futur/probabiliste/semaine] company=${companyId} semaine=${resultat.semaine.debut} negatives=${resultat.simulationsNegatives}/${resultat.nombreSimulations} analysees=${resultat.analysees} factures=${resultat.factures.length} arret=${resultat.couverture.arret?.cause ?? "aucun"} historique_ms=${historiqueMs} simulation_ms=${resultat.durees.simulationMs} analyse_ms=${resultat.durees.analyseMs} total_ms=${dureeRouteMs}`
    );
    const reponse: ReponseSemaine = { ...resultat, dureeRouteMs, historiqueMs };
    return NextResponse.json(reponse);
  } catch (erreur) {
    console.error(`[futur/probabiliste/semaine] échec company=${companyId}`, erreur);
    return NextResponse.json({ error: "L'analyse de la semaine n'a pas pu être calculée." }, { status: 500 });
  }
}
