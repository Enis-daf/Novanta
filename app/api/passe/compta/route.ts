import { NextRequest, NextResponse } from "next/server";
import { exigerAccesCompta } from "@/lib/comptaAcces";
import { erreurRegle, HORS_PERIMETRE, LigneComptable, MODELE_CORRESPONDANCE, RegleCorrespondance } from "@/lib/comptaCorrespondance";
import { calculerPnlComptable } from "@/lib/comptaPnl";
import {
  appliquerModele,
  chargerComptes,
  chargerEtatSynchro,
  chargerPremiereEcriture,
  chargerRegles,
  chargerSoldes,
  chargerSourceStock,
  enregistrerRegle,
  enregistrerSourceStock,
  supprimerRegle,
} from "@/lib/comptaRepository";
import { synchroComptableReelleActive } from "@/lib/featureFlags";
import { ajustementsDeLaPeriode, ajustementsDepuisStocks } from "@/lib/pastAdjustments";
import { periodeValide } from "@/lib/pastTransactions";
import { chargerStocks } from "@/lib/pastTransactionsRepository";

// P&L comptable de la période et sa correspondance. Calculé ici, sur les cumuls par compte : aucune
// ligne d'écriture ne part vers le navigateur. Lecture et paramétrage Novanta seulement : rien n'est
// écrit chez Pennylane.

const FORMAT_DATE_ISO = /^\d{4}-\d{2}-\d{2}$/;

export async function GET(req: NextRequest) {
  const acces = await exigerAccesCompta(req);
  if (acces instanceof NextResponse) return acces;
  const { admin, organizationId } = acces;

  const debut = req.nextUrl.searchParams.get("debut") ?? "";
  const fin = req.nextUrl.searchParams.get("fin") ?? "";
  if (!FORMAT_DATE_ISO.test(debut) || !FORMAT_DATE_ISO.test(fin) || !periodeValide({ debut, fin })) {
    return NextResponse.json({ error: "Période invalide." }, { status: 400 });
  }
  const periode = { debut, fin };

  try {
    const [soldes, regles, comptes, stocks, sourceStock, synchro, premiereEcriture] = await Promise.all([
      chargerSoldes(admin, organizationId, periode),
      chargerRegles(admin, organizationId),
      chargerComptes(admin, organizationId),
      chargerStocks(admin, organizationId),
      chargerSourceStock(admin, organizationId),
      chargerEtatSynchro(admin, organizationId),
      chargerPremiereEcriture(admin, organizationId),
    ]);
    const pnl = calculerPnlComptable({
      soldes,
      regles,
      libellesComptes: new Map(comptes.map((c) => [c.numero, c.libelle])),
      variationsStockNovanta: ajustementsDeLaPeriode(ajustementsDepuisStocks(stocks), periode),
      sourceStockChoisie: sourceStock,
    });
    return NextResponse.json({ pnl, regles, comptes, soldes, sourceStock, synchro, premiereEcriture, synchroDisponible: synchroComptableReelleActive() });
  } catch (error) {
    const code = (error as { code?: string } | null)?.code ?? "inconnu";
    console.error(`[passe/compta] step=load organization=${organizationId} code=${code}`);
    return NextResponse.json({ error: "Le P&L comptable n'a pas pu être chargé." }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  const acces = await exigerAccesCompta(req);
  if (acces instanceof NextResponse) return acces;
  const { admin, organizationId, user } = acces;

  let corps: { action?: unknown; prefixe?: unknown; destination?: unknown; categorie?: unknown; source?: unknown };
  try {
    corps = await req.json();
  } catch {
    return NextResponse.json({ error: "Requête invalide." }, { status: 400 });
  }

  try {
    switch (corps.action) {
      case "enregistrer_regle": {
        const regle: RegleCorrespondance = {
          prefixe: String(corps.prefixe ?? ""),
          destination: corps.destination as LigneComptable | typeof HORS_PERIMETRE,
          categorie: String(corps.categorie ?? ""),
        };
        const erreur = erreurRegle(regle);
        if (erreur) return NextResponse.json({ error: erreur }, { status: 400 });
        await enregistrerRegle(admin, organizationId, regle, user.id);
        return NextResponse.json({ ok: true });
      }
      case "supprimer_regle": {
        if (typeof corps.prefixe !== "string" || !/^\d{1,12}$/.test(corps.prefixe)) return NextResponse.json({ error: "Racine invalide." }, { status: 400 });
        await supprimerRegle(admin, organizationId, corps.prefixe, user.id);
        return NextResponse.json({ ok: true });
      }
      case "appliquer_modele":
        await appliquerModele(admin, organizationId, MODELE_CORRESPONDANCE, user.id);
        return NextResponse.json({ ok: true });
      case "source_stock": {
        if (corps.source !== "pennylane" && corps.source !== "novanta" && corps.source !== null) return NextResponse.json({ error: "Source invalide." }, { status: 400 });
        await enregistrerSourceStock(admin, organizationId, corps.source, user.id);
        return NextResponse.json({ ok: true });
      }
      default:
        return NextResponse.json({ error: "Action inconnue." }, { status: 400 });
    }
  } catch (error) {
    const code = (error as { code?: string } | null)?.code ?? "inconnu";
    console.error(`[passe/compta] step=save organization=${organizationId} code=${code}`);
    return NextResponse.json({ error: "La modification n'a pas pu être enregistrée." }, { status: 500 });
  }
}
