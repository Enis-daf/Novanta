import { NextRequest, NextResponse } from "next/server";
import { requireUser } from "@/lib/supabaseServer";
import { getOrCreateCompanyForBilling } from "@/lib/billing";
import { abonnementOffreEnCours, offreDuPrix } from "@/lib/offresStripe";

// Offre de l'abonnement Stripe de la société, pour la page Abonnement : les Price IDs ne sont lisibles
// que côté serveur. Lecture seule, n'attribue rien.
export async function GET(req: NextRequest) {
  const auth = await requireUser(req);
  if (!auth) {
    return NextResponse.json({ error: "Authentification requise." }, { status: 401 });
  }

  try {
    const company = await getOrCreateCompanyForBilling(auth.supabase, auth.user);
    return NextResponse.json({
      offre: offreDuPrix(company.subscriptionPlan),
      souscriptionPossible: !abonnementOffreEnCours(company.subscriptionStatus, company.subscriptionPlan),
    });
  } catch (error) {
    console.error("[billing/offre] échec", error);
    return NextResponse.json({ error: "Impossible de lire l'offre." }, { status: 500 });
  }
}
