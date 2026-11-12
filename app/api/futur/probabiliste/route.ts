import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin, supabaseAdminConfigured } from "@/lib/supabaseAdmin";
import { accesPrevisionProbabiliste } from "@/lib/probaAcces";
import { chargerFacturesBfr } from "@/lib/pastBfrRepository";
import { chargerFacturesPayeesFutur, enregistrerProfilSiChange } from "@/lib/probaRepository";
import { construireHistorique } from "@/lib/probaHistorique";
import { calibrerModele, ModeleRetards, ProfilPaiement, profilPaiement } from "@/lib/probaCalibration";
import { simuler, NOMBRE_SIMULATIONS_PAR_DEFAUT } from "@/lib/probaSimulation";
import { calculerIndicateurs } from "@/lib/probaIndicateurs";
import { GRAINE_PAR_DEFAUT } from "@/lib/probaAlea";
import { ReponseSimulation, ResumeCalibration, validerRequeteSimulation } from "@/lib/probaApi";
import { dateDansFuseau } from "@/lib/fiabiliteProjection";

// Prévision probabiliste de trésorerie (offre Pilotage). Le navigateur envoie les échéances de sa
// projection et leurs hypothèses ; ici, après contrôle de l'offre :
//   1. historique des retards de la société (factures Pennylane du module Passé + factures de
//      Futur réglées) — jamais celui d'une autre société ;
//   2. calibration des distributions de retard (clients, fournisseurs) et enregistrement du profil
//      de paiement s'il a changé ;
//   3. simulations, percentiles et indicateurs de risque — seuls les agrégats sont renvoyés.

export const dynamic = "force-dynamic";
export const fetchCache = "force-no-store";
export const maxDuration = 30;

function resume(modele: ModeleRetards, profil: ProfilPaiement): ResumeCalibration {
  return {
    nombreFactures: profil.nombreFactures,
    confiance: modele.confiance,
    retardMedian: profil.statistiques?.retardMedian ?? null,
    retardP90: profil.statistiques?.p90 ?? null,
    partALHeure: profil.statistiques?.partALHeure ?? null,
    partPlus30: profil.statistiques?.partPlus30 ?? null,
  };
}

export async function POST(req: NextRequest) {
  if (!supabaseAdminConfigured || !supabaseAdmin) {
    return NextResponse.json({ error: "Configuration serveur incomplète." }, { status: 500 });
  }
  const admin = supabaseAdmin;
  const acces = await accesPrevisionProbabiliste(req, "futur/probabiliste");
  if (!acces.ok) return acces.reponse;
  const { companyId } = acces;

  let corps: unknown;
  try {
    corps = await req.json();
  } catch {
    return NextResponse.json({ error: "Requête invalide." }, { status: 400 });
  }
  const validation = validerRequeteSimulation(corps);
  if (!validation.ok) return NextResponse.json({ error: validation.erreur }, { status: 400 });
  const requete = validation.valeur;

  try {
    const debut = Date.now();
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
    // Recalibration enregistrée au fil de l'eau ; son échec ne prive jamais l'utilisateur de sa prévision.
    await Promise.all(
      [profils.client, profils.fournisseur].map((p) =>
        enregistrerProfilSiChange(admin, companyId, p).catch((erreur) => console.error(`[futur/probabiliste] profil ${p.cote} non enregistré`, erreur))
      )
    );

    const graine = requete.graine ?? GRAINE_PAR_DEFAUT;
    const nombreSimulations = requete.nombreSimulations ?? NOMBRE_SIMULATIONS_PAR_DEFAUT;
    const brute = simuler({ ...requete, modeles, graine, nombreSimulations });
    const indicateurs = calculerIndicateurs(brute);
    console.log(
      `[futur/probabiliste] company=${companyId} simulations=${nombreSimulations} echeances=${requete.evenements.length} historique=${historique.client.length}/${historique.fournisseur.length} duree_ms=${Date.now() - debut}`
    );
    const reponse: ReponseSimulation = {
      indicateurs,
      calibration: { client: resume(modeles.client, profils.client), fournisseur: resume(modeles.fournisseur, profils.fournisseur) },
      dependancesIgnorees: brute.dependancesIgnorees,
      parametres: { nombreSimulations, graine, dateDepart: requete.dateDepart, horizonJours: requete.horizonJours },
    };
    return NextResponse.json(reponse);
  } catch (erreur) {
    console.error(`[futur/probabiliste] échec du calcul company=${companyId}`, erreur);
    return NextResponse.json({ error: "La prévision probabiliste n'a pas pu être calculée. Réessayez." }, { status: 500 });
  }
}
