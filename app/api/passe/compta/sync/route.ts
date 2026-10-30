import { randomUUID } from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import { exigerAccesCompta } from "@/lib/comptaAcces";
import { sourcePennylane } from "@/lib/comptaPennylaneAdapter";
import { enregistrerComptes, enregistrerEtatSynchro, enregistrerLignesPeriode } from "@/lib/comptaRepository";
import { synchroComptableReelleActive } from "@/lib/featureFlags";
import { periodeValide } from "@/lib/pastTransactions";
import { CompanyApiTokenCredentialProvider } from "@/lib/pennylaneCredentialProvider";
import { PennylaneApiError } from "@/lib/pennylaneClient";
import { cleChiffrementConfiguree } from "@/lib/pennylaneCrypto";
import { obtenirTokenPennylane } from "@/lib/pennylaneRepository";

// Lecture des comptes et écritures Pennylane, une tranche à la fois (un mois, rappelé par le
// navigateur). DÉSACTIVÉE tant que NOVANTA_COMPTA_SYNC_REELLE n'est pas posée : Pennylane n'a pas encore
// confirmé droits et limites. Aucun appel d'écriture : GET uniquement (lib/pennylaneClient.ts).

export const maxDuration = 60;

const FORMAT_DATE_ISO = /^\d{4}-\d{2}-\d{2}$/;
// Une tranche : un mois au plus, pour rester dans la durée d'une fonction serveur.
const MAX_JOURS_TRANCHE = 31;

export async function POST(req: NextRequest) {
  const acces = await exigerAccesCompta(req);
  if (acces instanceof NextResponse) return acces;
  const { admin, organizationId } = acces;

  if (!synchroComptableReelleActive()) {
    return NextResponse.json({ error: "La lecture des écritures Pennylane n'est pas encore activée.", code: "synchro_desactivee" }, { status: 503 });
  }
  if (!cleChiffrementConfiguree()) {
    console.error("[passe/compta/sync] config serveur manquante: PENNYLANE_TOKEN_ENCRYPTION_KEY absente ou invalide");
    return NextResponse.json({ error: "La synchronisation comptable a échoué." }, { status: 500 });
  }

  let corps: { debut?: unknown; fin?: unknown };
  try {
    corps = await req.json();
  } catch {
    return NextResponse.json({ error: "Requête invalide." }, { status: 400 });
  }
  const { debut, fin } = corps;
  if (typeof debut !== "string" || typeof fin !== "string" || !FORMAT_DATE_ISO.test(debut) || !FORMAT_DATE_ISO.test(fin) || !periodeValide({ debut, fin })) {
    return NextResponse.json({ error: "Période invalide." }, { status: 400 });
  }
  if ((new Date(fin).getTime() - new Date(debut).getTime()) / 86_400_000 >= MAX_JOURS_TRANCHE) {
    return NextResponse.json({ error: "Une synchronisation couvre un mois au plus." }, { status: 400 });
  }
  const periode = { debut, fin };

  try {
    const token = await obtenirTokenPennylane(admin, organizationId);
    if (!token) return NextResponse.json({ error: "Pennylane n'est pas connecté.", code: "non_connecte" }, { status: 400 });
    const source = sourcePennylane(new CompanyApiTokenCredentialProvider(token));
    await enregistrerEtatSynchro(admin, organizationId, source.nom, { statut: "running" });
    const nouveauxComptes = await enregistrerComptes(admin, organizationId, source.nom, await source.lireComptes());
    const { lignes, complete } = await source.lirePeriode(periode);
    await enregistrerLignesPeriode(admin, organizationId, source.nom, periode, lignes, complete, randomUUID());
    await enregistrerEtatSynchro(admin, organizationId, source.nom, { statut: complete ? "success" : "partial", couverture: periode, nombreLignes: lignes.length });
    return NextResponse.json({ nombreLignes: lignes.length, nouveauxComptes, complete });
  } catch (error) {
    const raison = error instanceof PennylaneApiError ? error.reason : "inconnu";
    console.error(`[passe/compta/sync] organization=${organizationId} reason=${raison}`);
    await enregistrerEtatSynchro(admin, organizationId, "pennylane", { statut: "error", codeErreur: raison }).catch(() => undefined);
    const refusee = error instanceof PennylaneApiError && error.reason === "insufficient_scope";
    return NextResponse.json(
      { error: refusee ? "Le token Pennylane n'a pas accès aux écritures comptables." : "La synchronisation comptable a échoué.", code: raison },
      { status: 502 }
    );
  }
}
