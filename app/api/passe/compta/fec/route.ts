import { createHash } from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import { exigerAccesCompta } from "@/lib/comptaAcces";
import { importerFec } from "@/lib/comptaRepository";
import { contenuCanonique, erreurImportFec, ImportFecPrepare } from "@/lib/fecParseur";

// Import d'un FEC : reçoit les balances mensuelles préparées par le navigateur, jamais le fichier ni ses écritures.
// Ne dépend pas de Pennylane. Rien de comptable dans les journaux : des compteurs seulement. Le remplacement d'un
// import existant n'a lieu que sur demande explicite.

export const maxDuration = 60;

export async function POST(req: NextRequest) {
  const acces = await exigerAccesCompta(req);
  if (acces instanceof NextResponse) return acces;
  const { admin, organizationId, user } = acces;

  let corps: { import?: unknown; remplacer?: unknown };
  try {
    corps = await req.json();
  } catch {
    return NextResponse.json({ error: "Requête invalide." }, { status: 400 });
  }
  const erreur = erreurImportFec(corps.import);
  if (erreur) return NextResponse.json({ error: erreur }, { status: 400 });
  const preparation = corps.import as ImportFecPrepare;
  const libelles = Object.fromEntries(Object.entries(preparation.libelles ?? {}).filter(([, l]) => typeof l === "string").map(([c, l]) => [c, (l as string).slice(0, 200)]));

  try {
    const empreinte = createHash("sha256").update(contenuCanonique(preparation)).digest("hex");
    const resultat = await importerFec(admin, organizationId, { ...preparation, libelles }, empreinte, corps.remplacer === true, user.id);
    console.log(`[passe/compta/fec] organization=${organizationId} statut=${resultat.statut} lignes_balance=${preparation.lignes.length}`);
    return NextResponse.json(resultat);
  } catch (error) {
    const code = (error as { code?: string } | null)?.code ?? "inconnu";
    console.error(`[passe/compta/fec] organization=${organizationId} code=${code}`);
    return NextResponse.json({ error: "L'import n'a pas pu être enregistré." }, { status: 500 });
  }
}
