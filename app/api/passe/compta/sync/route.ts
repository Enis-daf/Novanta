import { randomUUID } from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import { exigerAccesCompta } from "@/lib/comptaAcces";
import { sourcePennylane } from "@/lib/comptaPennylaneAdapter";
import { periodeEnMoisEntiers } from "@/lib/comptaPnl";
import { enregistrerBalanceDuMois, enregistrerComptes, enregistrerEtatSynchro } from "@/lib/comptaRepository";
import { synchroComptableReelleActive } from "@/lib/featureFlags";
import { CompanyApiTokenCredentialProvider } from "@/lib/pennylaneCredentialProvider";
import { PennylaneApiError } from "@/lib/pennylaneClient";
import { cleChiffrementConfiguree } from "@/lib/pennylaneCrypto";
import { obtenirTokenPennylane } from "@/lib/pennylaneRepository";

// Lecture de la balance Pennylane, un mois à la fois (rappelé par le navigateur), et du plan de comptes à
// la première tranche. DÉSACTIVÉE tant que NOVANTA_COMPTA_SYNC_REELLE n'est pas posée : Pennylane n'a pas
// encore répondu sur l'usage du token en production. Aucun appel d'écriture : GET uniquement.

export const maxDuration = 60;

const FORMAT_MOIS = /^\d{4}-(0[1-9]|1[0-2])$/;

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

  let corps: { mois?: unknown; avecComptes?: unknown };
  try {
    corps = await req.json();
  } catch {
    return NextResponse.json({ error: "Requête invalide." }, { status: 400 });
  }
  const { mois, avecComptes } = corps;
  if (typeof mois !== "string" || !FORMAT_MOIS.test(mois)) return NextResponse.json({ error: "Mois invalide." }, { status: 400 });
  // Un mois à venir n'a pas de balance à lire : une écriture datée dans le futur reste hors reporting.
  if (mois > new Date().toISOString().slice(0, 7)) return NextResponse.json({ error: "Ce mois n'a pas commencé." }, { status: 400 });

  try {
    const token = await obtenirTokenPennylane(admin, organizationId);
    if (!token) return NextResponse.json({ error: "Pennylane n'est pas connecté.", code: "non_connecte" }, { status: 400 });
    const source = sourcePennylane(new CompanyApiTokenCredentialProvider(token));
    await enregistrerEtatSynchro(admin, organizationId, source.nom, { statut: "running" });
    const nouveauxComptes = avecComptes === true ? await enregistrerComptes(admin, organizationId, source.nom, await source.lireComptes()) : 0;
    const { soldes, complete } = await source.lireBalanceDuMois(mois);
    const illisibles = await enregistrerBalanceDuMois(admin, organizationId, source.nom, mois, soldes, complete, randomUUID());
    await enregistrerEtatSynchro(admin, organizationId, source.nom, {
      statut: complete && illisibles === 0 ? "success" : "partial",
      couverture: periodeEnMoisEntiers({ debut: `${mois}-01`, fin: `${mois}-01` }),
      nombreLignes: soldes.length,
    });
    return NextResponse.json({ nombreComptes: soldes.length, nouveauxComptes, complete, illisibles });
  } catch (error) {
    const raison = error instanceof PennylaneApiError ? error.reason : "inconnu";
    console.error(`[passe/compta/sync] organization=${organizationId} reason=${raison}`);
    await enregistrerEtatSynchro(admin, organizationId, "pennylane", { statut: "error", codeErreur: raison }).catch(() => undefined);
    const refusee = error instanceof PennylaneApiError && error.reason === "insufficient_scope";
    return NextResponse.json(
      { error: refusee ? "Le token Pennylane n'a pas accès à la balance comptable." : "La synchronisation comptable a échoué.", code: raison },
      { status: 502 }
    );
  }
}
