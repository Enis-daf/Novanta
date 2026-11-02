import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { SupabaseClient } from "@supabase/supabase-js";
import type Stripe from "stripe";
import { CAPACITES, Capacite, droitsOrganisation } from "./offres";
import { abonnementOffreEnCours, estOffrePayante, offreDuPrix, prixDeLOffre } from "./offresStripe";
import { synchroniserAbonnement } from "./stripeAbonnement";

const PRIX_PREVISION = "price_1UXO6KV05PdV9lFGeC5ZHjFt";
const PRIX_PILOTAGE = "price_1UXO6qV05PdV9lFGjcqvzirH";
const PRIX_ANCIEN = "price_ancien_9_99";

const MAINTENANT = new Date("2026-11-02T12:00:00Z");
const FIN_PERIODE_UNIX = Date.parse("2026-12-02T12:00:00Z") / 1000;
const FIN_ESSAI = "2026-11-20T12:00:00.000Z";

type Ligne = Record<string, unknown>;

function abonnement(id: string, status: string, prix: string, extra: Partial<Stripe.Subscription> = {}): Stripe.Subscription {
  return {
    id,
    status,
    customer: "cus_1",
    metadata: { company_id: "soc-1" },
    items: { data: [{ price: { id: prix }, current_period_end: FIN_PERIODE_UNIX }] },
    ...extra,
  } as unknown as Stripe.Subscription;
}

// Faux Stripe : le webhook relit toujours l'abonnement, ce magasin est donc la seule vérité.
function fauxStripe(abonnements: Stripe.Subscription[]) {
  const resilies: string[] = [];
  const client = {
    subscriptions: {
      retrieve: async (id: string) => {
        const trouve = abonnements.find((a) => a.id === id);
        if (!trouve) throw Object.assign(new Error("No such subscription"), { code: "resource_missing" });
        return trouve;
      },
      cancel: async (id: string) => {
        resilies.push(id);
        const trouve = abonnements.find((a) => a.id === id)!;
        (trouve as { status: string }).status = "canceled";
        return trouve;
      },
    },
  } as unknown as Stripe;
  return { client, resilies };
}

// Faux client service_role : une seule ligne companies, avec les lectures et l'update du webhook.
function fauxAdmin(societe: Ligne) {
  const requete = (col: string, val: unknown) => ({
    maybeSingle: async () => ({ data: societe[col] === val ? societe : null, error: null }),
  });
  return {
    from: () => ({
      select: () => ({ eq: requete }),
      update: (patch: Ligne) => ({
        eq: async () => {
          Object.assign(societe, patch);
          return { error: null };
        },
      }),
    }),
  } as unknown as SupabaseClient;
}

function societeEssentiel(extra: Ligne = {}): Ligne {
  return {
    id: "soc-1",
    plan: "essential",
    plan_override: null,
    plan_override_until: null,
    stripe_customer_id: "cus_1",
    stripe_subscription_id: null,
    subscription_status: null,
    subscription_plan: null,
    subscription_current_period_end: null,
    access_enabled: true,
    ...extra,
  };
}

function societeEnEssai(plan: string): Ligne {
  return societeEssentiel({
    plan,
    stripe_subscription_id: "sub_essai",
    subscription_status: "trialing",
    subscription_plan: PRIX_ANCIEN,
    subscription_current_period_end: FIN_ESSAI,
  });
}

const offre = (societe: Ligne, quand: Date = MAINTENANT) => droitsOrganisation(societe, quand).offreEffective;
const capacites = (societe: Ligne): Capacite[] => {
  const droits = droitsOrganisation(societe, MAINTENANT).capacites;
  return CAPACITES.filter((c) => droits[c]);
};

describe("correspondance Price <-> offre", () => {
  test("les deux Price IDs fournis donnent Prévision et Pilotage", () => {
    assert.equal(offreDuPrix(PRIX_PREVISION), "forecast");
    assert.equal(offreDuPrix(PRIX_PILOTAGE), "steering");
    assert.equal(prixDeLOffre("forecast", "sk_test_x"), PRIX_PREVISION);
    assert.equal(prixDeLOffre("steering", "sk_test_x"), PRIX_PILOTAGE);
  });

  test("Price inconnu ou absent : aucune offre", () => {
    for (const prix of [PRIX_ANCIEN, "", null, undefined]) assert.equal(offreDuPrix(prix), null);
  });

  test("clé live sans Price live : jamais de Price de test envoyé à Stripe", () => {
    assert.equal(prixDeLOffre("forecast", "sk_live_x"), null);
    assert.equal(prixDeLOffre("steering", "sk_live_x"), null);
  });

  test("seules Prévision et Pilotage se souscrivent", () => {
    for (const valeur of ["essential", "test", "Pilotage", PRIX_PILOTAGE, null, 1]) assert.equal(estOffrePayante(valeur), false);
    assert.equal(estOffrePayante("forecast"), true);
    assert.equal(estOffrePayante("steering"), true);
  });

  test("Checkout bloqué sur une offre en cours, ouvert après la fin ou sur un ancien abonnement", () => {
    assert.equal(abonnementOffreEnCours("active", PRIX_PREVISION), true);
    assert.equal(abonnementOffreEnCours("past_due", PRIX_PILOTAGE), true);
    assert.equal(abonnementOffreEnCours("canceled", PRIX_PREVISION), false);
    assert.equal(abonnementOffreEnCours("trialing", PRIX_ANCIEN), false);
    assert.equal(abonnementOffreEnCours("active", PRIX_ANCIEN), false);
    assert.equal(abonnementOffreEnCours(null, null), false);
  });
});

describe("souscription", () => {
  test("Essentiel -> Prévision : abonnement reconnu, droits Prévision", async () => {
    const societe = societeEssentiel();
    const { client } = fauxStripe([abonnement("sub_1", "active", PRIX_PREVISION)]);
    await synchroniserAbonnement(client, fauxAdmin(societe), "sub_1", null, MAINTENANT);
    assert.equal(societe.plan, "forecast");
    assert.equal(societe.stripe_subscription_id, "sub_1");
    assert.equal(societe.subscription_status, "active");
    assert.equal(societe.subscription_current_period_end, "2026-12-02T12:00:00.000Z");
    assert.deepEqual(capacites(societe), ["canViewReporting", "canViewForecast", "canViewVarianceAnalysis", "canViewWorkingCapital"]);
  });

  test("Essentiel -> Pilotage : droits Pilotage", async () => {
    const societe = societeEssentiel();
    const { client } = fauxStripe([abonnement("sub_1", "active", PRIX_PILOTAGE)]);
    await synchroniserAbonnement(client, fauxAdmin(societe), "sub_1", null, MAINTENANT);
    assert.equal(societe.plan, "steering");
    assert.deepEqual(capacites(societe), [...CAPACITES]);
  });

  test("nouvelle société sans accès : le paiement ouvre l'accès", async () => {
    const societe = societeEssentiel({ plan: "steering", access_enabled: false });
    const { client } = fauxStripe([abonnement("sub_1", "active", PRIX_PREVISION)]);
    await synchroniserAbonnement(client, fauxAdmin(societe), "sub_1", null, MAINTENANT);
    assert.equal(societe.access_enabled, true);
    assert.equal(societe.plan, "forecast");
  });

  test("paiement initial non confirmé (incomplete) : aucun droit", async () => {
    const societe = societeEssentiel();
    const { client } = fauxStripe([abonnement("sub_1", "incomplete", PRIX_PILOTAGE)]);
    await synchroniserAbonnement(client, fauxAdmin(societe), "sub_1", null, MAINTENANT);
    assert.equal(societe.plan, "essential");
    assert.equal(societe.stripe_subscription_id, null);
  });

  test("changement d'offre dans le portail : même abonnement, nouveau Price", async () => {
    const societe = societeEssentiel();
    const sub = abonnement("sub_1", "active", PRIX_PREVISION);
    const { client } = fauxStripe([sub]);
    const admin = fauxAdmin(societe);
    await synchroniserAbonnement(client, admin, "sub_1", null, MAINTENANT);
    (sub.items.data[0] as unknown as { price: { id: string } }).price.id = PRIX_PILOTAGE;
    await synchroniserAbonnement(client, admin, "sub_1", null, MAINTENANT);
    assert.equal(societe.plan, "steering");
  });

  test("le rattachement passe par le client Stripe quand le metadata manque", async () => {
    const societe = societeEssentiel();
    const { client } = fauxStripe([abonnement("sub_1", "active", PRIX_PREVISION, { metadata: {} })]);
    await synchroniserAbonnement(client, fauxAdmin(societe), "sub_1", null, MAINTENANT);
    assert.equal(societe.plan, "forecast");
  });
});

describe("souscription pendant un Test", () => {
  test("Prévision pendant le Test : Pilotage jusqu'à l'échéance, puis Prévision", async () => {
    const societe = societeEnEssai("essential");
    const { client, resilies } = fauxStripe([
      abonnement("sub_essai", "trialing", PRIX_ANCIEN),
      abonnement("sub_prev", "active", PRIX_PREVISION),
    ]);
    await synchroniserAbonnement(client, fauxAdmin(societe), "sub_prev", null, MAINTENANT);

    assert.equal(societe.plan, "forecast");
    assert.equal(societe.subscription_status, "active");
    assert.equal(offre(societe), "steering");
    assert.equal(offre(societe, new Date("2026-11-20T11:59:59Z")), "steering");
    assert.equal(offre(societe, new Date("2026-11-20T12:00:01Z")), "forecast");
    assert.deepEqual(resilies, ["sub_essai"], "l'essai est résilié pour éviter une double facturation");
  });

  test("la fin de l'essai remplacé ne coupe pas l'abonnement payé (événement deleted, même rejoué)", async () => {
    const societe = societeEnEssai("essential");
    const { client } = fauxStripe([
      abonnement("sub_essai", "trialing", PRIX_ANCIEN),
      abonnement("sub_prev", "active", PRIX_PREVISION),
    ]);
    const admin = fauxAdmin(societe);
    await synchroniserAbonnement(client, admin, "sub_prev", null, MAINTENANT);
    const avant = { ...societe };
    await synchroniserAbonnement(client, admin, "sub_essai", null, MAINTENANT);
    await synchroniserAbonnement(client, admin, "sub_essai", null, MAINTENANT);
    assert.deepEqual(societe, avant);
  });

  test("Pilotage pendant le Test : Pilotage avant et après l'échéance", async () => {
    const societe = societeEnEssai("essential");
    const { client } = fauxStripe([
      abonnement("sub_essai", "trialing", PRIX_ANCIEN),
      abonnement("sub_pil", "active", PRIX_PILOTAGE),
    ]);
    await synchroniserAbonnement(client, fauxAdmin(societe), "sub_pil", null, MAINTENANT);
    assert.equal(offre(societe), "steering");
    assert.equal(offre(societe, new Date("2026-12-01T00:00:00Z")), "steering");
  });

  test("Test par override Novanta : le paiement ne le modifie pas", async () => {
    const societe = societeEssentiel({ plan_override: "steering", plan_override_until: FIN_ESSAI });
    const { client } = fauxStripe([abonnement("sub_prev", "active", PRIX_PREVISION)]);
    await synchroniserAbonnement(client, fauxAdmin(societe), "sub_prev", null, MAINTENANT);
    assert.equal(societe.plan_override, "steering");
    assert.equal(societe.plan_override_until, FIN_ESSAI);
    assert.equal(offre(societe), "steering");
    assert.equal(offre(societe, new Date("2026-11-21T00:00:00Z")), "forecast");
  });

  test("abonnement terminé pendant un Test : Pilotage jusqu'à l'échéance, puis Essentiel", async () => {
    const societe = societeEssentiel({ plan_override: "steering", plan_override_until: FIN_ESSAI });
    const sub = abonnement("sub_prev", "active", PRIX_PREVISION);
    const { client } = fauxStripe([sub]);
    const admin = fauxAdmin(societe);
    await synchroniserAbonnement(client, admin, "sub_prev", null, MAINTENANT);
    (sub as { status: string }).status = "canceled";
    await synchroniserAbonnement(client, admin, "sub_prev", null, MAINTENANT);
    assert.equal(offre(societe), "steering");
    assert.equal(offre(societe, new Date("2026-11-21T00:00:00Z")), "essential");
  });
});

describe("annulation", () => {
  for (const [nom, prix, attendue] of [
    ["Prévision", PRIX_PREVISION, "forecast"],
    ["Pilotage", PRIX_PILOTAGE, "steering"],
  ] as const) {
    test(`${nom} : conservée jusqu'à l'échéance, Essentiel après la fin réelle`, async () => {
      const societe = societeEssentiel();
      const sub = abonnement("sub_1", "active", prix);
      const { client } = fauxStripe([sub]);
      const admin = fauxAdmin(societe);
      await synchroniserAbonnement(client, admin, "sub_1", null, MAINTENANT);

      // Annulation programmée : Stripe laisse le statut « active » jusqu'à la fin de période.
      (sub as { cancel_at_period_end: boolean }).cancel_at_period_end = true;
      await synchroniserAbonnement(client, admin, "sub_1", null, MAINTENANT);
      assert.equal(offre(societe), attendue);
      assert.equal(societe.access_enabled, true);

      (sub as { status: string }).status = "canceled";
      await synchroniserAbonnement(client, admin, "sub_1", null, MAINTENANT);
      assert.equal(societe.plan, "essential");
      assert.equal(societe.subscription_status, "canceled");
      assert.equal(societe.access_enabled, true, "Essentiel est gratuit : l'accès reste ouvert");
      assert.deepEqual(capacites(societe), ["canViewReporting"]);
    });
  }

  test("nouvelle souscription après une fin réelle : un abonnement terminé n'est pas résilié deux fois", async () => {
    const societe = societeEssentiel({ stripe_subscription_id: "sub_vieux", subscription_status: "canceled", subscription_plan: PRIX_PREVISION });
    const { client, resilies } = fauxStripe([
      abonnement("sub_vieux", "canceled", PRIX_PREVISION),
      abonnement("sub_neuf", "active", PRIX_PILOTAGE),
    ]);
    await synchroniserAbonnement(client, fauxAdmin(societe), "sub_neuf", null, MAINTENANT);
    assert.equal(societe.plan, "steering");
    assert.deepEqual(resilies, []);
  });
});

describe("paiement en échec", () => {
  test("past_due : statut enregistré, offre et accès conservés (pas de blocage brutal)", async () => {
    const societe = societeEssentiel();
    const sub = abonnement("sub_1", "active", PRIX_PILOTAGE);
    const { client } = fauxStripe([sub]);
    const admin = fauxAdmin(societe);
    await synchroniserAbonnement(client, admin, "sub_1", null, MAINTENANT);
    (sub as { status: string }).status = "past_due";
    await synchroniserAbonnement(client, admin, "sub_1", null, MAINTENANT);
    assert.equal(societe.subscription_status, "past_due");
    assert.equal(societe.plan, "steering");
    assert.equal(societe.access_enabled, true);
  });
});

describe("anciens abonnements à prix unique : comportement inchangé", () => {
  test("offre attribuée à la main jamais écrasée par un Price inconnu", async () => {
    const societe = societeEssentiel({ plan: "forecast", stripe_subscription_id: "sub_a", subscription_plan: PRIX_ANCIEN });
    const { client } = fauxStripe([abonnement("sub_a", "active", PRIX_ANCIEN)]);
    await synchroniserAbonnement(client, fauxAdmin(societe), "sub_a", null, MAINTENANT);
    assert.equal(societe.plan, "forecast");
  });

  test("fin d'un ancien abonnement : accès coupé, offre non modifiée", async () => {
    const societe = societeEssentiel({ plan: "steering", stripe_subscription_id: "sub_a", subscription_plan: PRIX_ANCIEN });
    const { client } = fauxStripe([abonnement("sub_a", "canceled", PRIX_ANCIEN)]);
    await synchroniserAbonnement(client, fauxAdmin(societe), "sub_a", null, MAINTENANT);
    assert.equal(societe.access_enabled, false);
    assert.equal(societe.plan, "steering");
  });

  test("essai Stripe en cours : droits Pilotage conservés, sans override", async () => {
    const societe = societeEnEssai("forecast");
    const { client } = fauxStripe([abonnement("sub_essai", "trialing", PRIX_ANCIEN)]);
    await synchroniserAbonnement(client, fauxAdmin(societe), "sub_essai", null, MAINTENANT);
    assert.equal(societe.plan, "forecast");
    assert.equal(societe.plan_override, null);
    assert.equal(offre(societe), "steering");
  });
});

describe("événement envoyé plusieurs fois", () => {
  test("même état après un ou trois passages, sans double résiliation", async () => {
    const societe = societeEnEssai("essential");
    const { client, resilies } = fauxStripe([
      abonnement("sub_essai", "trialing", PRIX_ANCIEN),
      abonnement("sub_prev", "active", PRIX_PREVISION),
    ]);
    const admin = fauxAdmin(societe);
    await synchroniserAbonnement(client, admin, "sub_prev", null, MAINTENANT);
    const apresUn = { ...societe };
    await synchroniserAbonnement(client, admin, "sub_prev", null, MAINTENANT);
    await synchroniserAbonnement(client, admin, "sub_prev", null, MAINTENANT);
    assert.deepEqual(societe, apresUn);
    assert.deepEqual(resilies, ["sub_essai"]);
  });

  test("événement ancien reçu après la fin : l'état relu chez Stripe fait foi", async () => {
    const societe = societeEssentiel({ stripe_subscription_id: "sub_1", subscription_plan: PRIX_PREVISION, plan: "forecast" });
    const { client } = fauxStripe([abonnement("sub_1", "canceled", PRIX_PREVISION)]);
    await synchroniserAbonnement(client, fauxAdmin(societe), "sub_1", null, MAINTENANT);
    assert.equal(societe.plan, "essential");
  });
});

describe("route webhook : signature", () => {
  const SECRET = "whsec_test_novanta";
  const corps = JSON.stringify({ id: "evt_1", object: "event", type: "customer.subscription.updated", data: { object: { id: "sub_1" } } });

  // Route réelle, sans client service_role : passer la signature mène à l'erreur 500 « Supabase »,
  // la rejeter répond 400 avant d'atteindre toute écriture.
  async function appeler(signature: string | null) {
    process.env.STRIPE_SECRET_KEY = "sk_test_novanta";
    process.env.STRIPE_WEBHOOK_SECRET = SECRET;
    delete process.env.SUPABASE_SERVICE_ROLE_KEY;
    const { POST } = await import("../app/api/stripe/webhook/route");
    const { NextRequest } = await import("next/server");
    const headers: Record<string, string> = signature ? { "stripe-signature": signature } : {};
    return POST(new NextRequest("http://localhost/api/stripe/webhook", { method: "POST", body: corps, headers }));
  }

  test("signature absente : 400", async () => {
    assert.equal((await appeler(null)).status, 400);
  });

  test("signature invalide ou d'un autre secret : 400", async () => {
    const { default: StripeSdk } = await import("stripe");
    const sdk = new StripeSdk("sk_test_novanta");
    const autreSecret = sdk.webhooks.generateTestHeaderString({ payload: corps, secret: "whsec_autre" });
    assert.equal((await appeler("t=1,v1=faux")).status, 400);
    assert.equal((await appeler(autreSecret)).status, 400);
  });

  test("corps modifié après signature : 400 ; signature valide : acceptée", async () => {
    const { default: StripeSdk } = await import("stripe");
    const sdk = new StripeSdk("sk_test_novanta");
    const autreCorps = sdk.webhooks.generateTestHeaderString({ payload: corps + " ", secret: SECRET });
    assert.equal((await appeler(autreCorps)).status, 400);
    const valide = sdk.webhooks.generateTestHeaderString({ payload: corps, secret: SECRET });
    assert.equal((await appeler(valide)).status, 500);
  });
});

describe("Checkout : garde-fous statiques", () => {
  const route = readFileSync(join(process.cwd(), "app/api/billing/create-checkout-session/route.ts"), "utf8");

  test("pas d'essai Stripe, Price lu côté serveur, offre validée", () => {
    assert.ok(!route.includes("trial_period_days"));
    assert.ok(route.includes("estOffrePayante(offre)"));
    assert.ok(route.includes("line_items: [{ price: priceId, quantity: 1 }]"));
    assert.ok(!/corps\?\.(price|plan)/.test(route));
  });

  test("la société vient du token, jamais du client", () => {
    assert.ok(route.includes("getOrCreateCompanyForBilling(supabase, user)"));
    assert.ok(!route.includes("corps?.company"));
  });

  test("le retour de Checkout n'attribue rien : seul le webhook écrit plan", () => {
    const page = readFileSync(join(process.cwd(), "app/account/billing/page.tsx"), "utf8");
    assert.ok(!route.includes("plan:"));
    assert.ok(!page.includes(".update("));
  });
});
