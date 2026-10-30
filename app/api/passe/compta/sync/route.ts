import { NextRequest, NextResponse } from "next/server";
import { exigerAccesCompta } from "@/lib/comptaAcces";
import { sourcePennylane } from "@/lib/comptaPennylaneAdapter";
import { depotSupabase } from "@/lib/comptaRepository";
import { synchroniserSociete } from "@/lib/comptaSynchro";
import { synchroComptableReelleActive } from "@/lib/featureFlags";
import { limiteurDebit } from "@/lib/pastBfrSync";
import { CompanyApiTokenCredentialProvider } from "@/lib/pennylaneCredentialProvider";
import { cleChiffrementConfiguree } from "@/lib/pennylaneCrypto";
import { obtenirTokenPennylane } from "@/lib/pennylaneRepository";

// Synchronisation à la demande, côté serveur : tous les exercices non clôturés et commencés, ou un exercice
// désigné pour une resynchronisation exceptionnelle. DÉSACTIVÉE tant que NOVANTA_COMPTA_SYNC_REELLE n'est pas
// posée. Aucun appel d'écriture chez Pennylane : GET uniquement.

export const maxDuration = 300;

export async function POST(req: NextRequest) {
  const acces = await exigerAccesCompta(req);
  if (acces instanceof NextResponse) return acces;
  const { admin, organizationId } = acces;

  if (!synchroComptableReelleActive()) {
    return NextResponse.json({ error: "La lecture de la balance Pennylane n'est pas encore activée.", code: "synchro_desactivee" }, { status: 503 });
  }
  if (!cleChiffrementConfiguree()) {
    console.error("[passe/compta/sync] config serveur manquante: PENNYLANE_TOKEN_ENCRYPTION_KEY absente ou invalide");
    return NextResponse.json({ error: "La synchronisation comptable a échoué." }, { status: 500 });
  }

  let corps: { type?: unknown; idExercice?: unknown; confirmation?: unknown };
  try {
    corps = await req.json();
  } catch {
    return NextResponse.json({ error: "Requête invalide." }, { status: 400 });
  }
  const exceptionnelle = corps.type === "exceptionnel";
  if (!exceptionnelle && corps.type !== "manuel") return NextResponse.json({ error: "Type de synchronisation inconnu." }, { status: 400 });
  // Rouvrir un exercice clôturé ne se fait jamais par accident.
  if (exceptionnelle && (typeof corps.idExercice !== "string" || corps.confirmation !== true)) {
    return NextResponse.json({ error: "Resynchronisation exceptionnelle non confirmée." }, { status: 400 });
  }

  try {
    const token = await obtenirTokenPennylane(admin, organizationId);
    if (!token) return NextResponse.json({ error: "Pennylane n'est pas connecté.", code: "non_connecte" }, { status: 400 });

    const resultat = await synchroniserSociete(sourcePennylane(new CompanyApiTokenCredentialProvider(token)), depotSupabase(admin, organizationId, "pennylane"), {
      declencheur: exceptionnelle ? "exceptionnel" : "manuel",
      idExercice: exceptionnelle ? (corps.idExercice as string) : undefined,
      aujourdhui: new Date().toISOString().slice(0, 10),
      reserver: limiteurDebit(20, 5000),
    });
    if (!resultat.lancee) {
      return resultat.raison === "deja_en_cours"
        ? NextResponse.json({ error: "Une synchronisation est déjà en cours.", code: "deja_en_cours" }, { status: 409 })
        : NextResponse.json({ error: "Exercice inconnu.", code: "exercice_inconnu" }, { status: 400 });
    }
    const { bilan } = resultat;
    console.log(`[passe/compta/sync] organization=${organizationId} statut=${bilan.statut} demandes=${bilan.moisDemandes} actualises=${bilan.moisActualises} echecs=${bilan.moisEnEchec.length}`);
    return NextResponse.json({ bilan });
  } catch (error) {
    const code = (error as { code?: string } | null)?.code ?? "inconnu";
    console.error(`[passe/compta/sync] organization=${organizationId} code=${code}`);
    return NextResponse.json({ error: "La synchronisation comptable a échoué." }, { status: 502 });
  }
}
