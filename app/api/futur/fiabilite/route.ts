import { createHash } from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import { requireUser } from "@/lib/supabaseServer";
import { supabaseAdmin, supabaseAdminConfigured } from "@/lib/supabaseAdmin";
import { getOrCreateCompanyForBilling } from "@/lib/billing";
import { moduleActifPourOrganisation } from "@/lib/organizationModules";
import { chargerAxeConfigure, chargerExercice, chargerMappingsCategories, chargerPastTransactions } from "@/lib/pastTransactionsRepository";
import { indexerMappings } from "@/lib/pastCategoryMapping";
import {
  comparer,
  construireRealise,
  CouvertureReference,
  LignePrevue,
  dateDansFuseau,
  empreinteResultat,
  instantCloture,
  PeriodeFiabilite,
  periodesTerminees,
  statutRealise,
  SynchronisationPasse,
  TotauxFlux,
  TypePeriode,
} from "@/lib/fiabiliteProjection";
import type { DetailFiabilite, PointFiabilite, ReponseFiabilite, RevisionFiabilite } from "@/lib/fiabiliteApi";

// Fiabilité de la projection : prévision de référence (future_forecast_references) contre réalisé
// bancaire de Passé, sur les mêmes dates. Réservé aux organisations qui ont le module Passé : le
// contrôle est fait ici, côté serveur, et toutes les lectures sont bornées à la société de
// l'utilisateur connecté (jamais un identifiant fourni par le navigateur).
//
// Chaque consultation recalcule le réalisé des périodes ayant une référence et enregistre une
// nouvelle révision dans future_accuracy_results seulement si le réalisé ou son classement a changé
// (empreinte). La référence n'est jamais modifiée.

export const dynamic = "force-dynamic";
export const fetchCache = "force-no-store";
const NOMBRE_PERIODES = { month: 12, quarter: 8 } as const;

type Row = Record<string, unknown>;

export async function GET(req: NextRequest) {
  if (!supabaseAdminConfigured || !supabaseAdmin) {
    return NextResponse.json({ error: "Configuration serveur incomplète." }, { status: 500 });
  }
  const admin = supabaseAdmin;
  const auth = await requireUser(req);
  if (!auth) return NextResponse.json({ error: "Authentification requise." }, { status: 401 });

  const type: TypePeriode = req.nextUrl.searchParams.get("type") === "quarter" ? "quarter" : "month";
  const debutDemande = req.nextUrl.searchParams.get("debut");

  let companyId: string;
  try {
    const company = await getOrCreateCompanyForBilling(auth.supabase, auth.user);
    if (!company?.id || !company.accessEnabled) return NextResponse.json({ error: "Accès refusé." }, { status: 403 });
    if (!(await moduleActifPourOrganisation(auth.supabase, company.id, "past"))) {
      return NextResponse.json({ error: "Module Passé requis.", code: "module_passe_requis" }, { status: 403 });
    }
    companyId = company.id;
  } catch (erreur) {
    console.error(`[futur/fiabilite] société introuvable pour l'utilisateur ${auth.user.id}`, erreur);
    return NextResponse.json({ error: "Société introuvable." }, { status: 500 });
  }

  try {
    const maintenant = new Date();
    const aujourdhui = dateDansFuseau(maintenant);
    const exercice = await chargerExercice(admin, companyId);
    const periodes = periodesTerminees(type, aujourdhui, exercice, NOMBRE_PERIODES[type]);
    const selection = periodes.find((p) => p.debut === debutDemande) ?? periodes[0];
    const etendue = { debut: periodes[periodes.length - 1].debut, fin: periodes[0].fin };

    const [refsRes, syncsRes, resultatsRes, mappings, axe, transactions] = await Promise.all([
      admin
        .from("future_forecast_references")
        .select("id, period_start, period_end, reference_at, captured_at, capture_mode, totals, lines, coverage")
        .eq("company_id", companyId)
        .eq("period_kind", type)
        .eq("status", "official")
        .gte("period_start", etendue.debut)
        .lte("period_start", etendue.fin),
      admin.from("past_sync_runs").select("period_start, period_end, synced_at, complete").eq("organization_id", companyId),
      admin
        .from("future_accuracy_results")
        .select("period_start, revision, computed_at, fingerprint, result")
        .eq("company_id", companyId)
        .eq("period_kind", type)
        .gte("period_start", etendue.debut)
        .order("revision", { ascending: false }),
      chargerMappingsCategories(admin, companyId),
      chargerAxeConfigure(admin, companyId),
      chargerPastTransactions(admin, companyId, etendue),
    ]);
    for (const r of [refsRes, syncsRes, resultatsRes]) if (r.error) throw r.error;

    const refs = new Map(((refsRes.data ?? []) as Row[]).map((r) => [r.period_start as string, r]));
    const synchronisations: SynchronisationPasse[] = ((syncsRes.data ?? []) as Row[]).map((s) => ({
      debut: s.period_start as string,
      fin: s.period_end as string,
      synchroniseLe: s.synced_at as string,
      complete: Boolean(s.complete),
    }));
    const resultats = (resultatsRes.data ?? []) as Row[];
    const index = indexerMappings(mappings);

    const points: PointFiabilite[] = [];
    let detail: DetailFiabilite | null = null;

    for (const periode of periodes) {
      const ref = refs.get(periode.debut) ?? null;
      const realise = construireRealise(transactions, periode, index, axe);
      const sources = new Set(transactions.filter((t) => t.transactionDate >= periode.debut && t.transactionDate <= periode.fin).map((t) => t.sourceType));
      const statut = statutRealise(periode, synchronisations, sources);
      const comparaison = ref ? comparer(ref.totals as TotauxFlux, realise.totaux) : null;
      const siens = resultats.filter((r) => r.period_start === periode.debut);
      let revision = siens.length > 0 ? Number(siens[0].revision) : null;

      if (ref && comparaison) {
        const empreinte = createHash("sha256").update(empreinteResultat(ref.id as string, realise, statut.statut)).digest("hex");
        if (siens[0]?.fingerprint !== empreinte) {
          revision = (revision ?? 0) + 1;
          const ligne = {
            company_id: companyId,
            period_kind: type,
            period_start: periode.debut,
            revision,
            reference_id: ref.id,
            computed_at: maintenant.toISOString(),
            actual_synced_at: statut.synchroniseLe,
            actual_status: statut.statut === "complet" ? "complete" : statut.statut === "incomplet" ? "incomplete" : "unverifiable",
            fingerprint: empreinte,
            result: { comparaison, totauxRealise: realise.totaux, statut, nombreTransactions: realise.nombreTransactions },
          };
          const { error } = await admin
            .from("future_accuracy_results")
            .upsert(ligne, { onConflict: "company_id,period_kind,period_start,revision", ignoreDuplicates: true });
          if (error) throw error;
          siens.unshift({ period_start: periode.debut, revision, computed_at: ligne.computed_at, fingerprint: empreinte, result: ligne.result });
        }
      }

      const publiable = Boolean(ref) && statut.statut === "complet";
      points.push({
        periode,
        referenceDisponible: Boolean(ref),
        statutRealise: statut.statut,
        publiable,
        globale: publiable && comparaison ? comparaison.globale : null,
        encaissements: publiable && comparaison ? comparaison.encaissements.precision : null,
        decaissements: publiable && comparaison ? comparaison.decaissements.precision : null,
        revision,
      });

      if (periode.debut === selection.debut) {
        const revisions: RevisionFiabilite[] = siens.map((r) => {
          const res = r.result as { comparaison?: { globale?: PointFiabilite["globale"] }; totauxRealise: TotauxFlux };
          return { revision: Number(r.revision), calculeLe: r.computed_at as string, globale: res.comparaison?.globale ?? null, totauxRealise: res.totauxRealise };
        });
        detail = {
          periode: selection as PeriodeFiabilite,
          reference: ref
            ? {
                arreteeAu: (ref.reference_at as string) ?? instantCloture(periode).toISOString(),
                captureeLe: ref.captured_at as string,
                modeCapture: ref.capture_mode as "before_close" | "after_close_unchanged",
                lignes: ref.lines as LignePrevue[],
                totaux: ref.totals as TotauxFlux,
                couverture: ref.coverage as CouvertureReference,
              }
            : null,
          realise: { lignes: realise.lignes, totaux: realise.totaux, nombreTransactions: realise.nombreTransactions },
          statutRealise: statut,
          comparaison,
          revisions,
        };
      }
    }

    const derniereSynchronisation = [...synchronisations].sort((a, b) => b.synchroniseLe.localeCompare(a.synchroniseLe))[0]?.synchroniseLe ?? null;
    const reponse: ReponseFiabilite = { aujourdhui, derniereSynchronisation, points, detail: detail! };
    return NextResponse.json(reponse);
  } catch (erreur) {
    const code = (erreur as { code?: string } | null)?.code ?? "inconnu";
    console.error(`[futur/fiabilite] company=${companyId} échec code=${code}`, erreur);
    // Tables absentes : migration 20261026 non appliquée sur cette base.
    if (code === "42P01" || code === "PGRST205") {
      return NextResponse.json({ error: "Fiabilité de la projection pas encore activée sur cette base.", code: "migration_absente" }, { status: 503 });
    }
    return NextResponse.json({ error: "Comparaison indisponible pour le moment." }, { status: 500 });
  }
}
