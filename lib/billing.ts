import type { SupabaseClient, User } from "@supabase/supabase-js";

export interface CompanyBilling {
  id: string;
  name: string;
  firstName: string | null;
  lastName: string | null;
  stripeCustomerId: string | null;
  stripeSubscriptionId: string | null;
  subscriptionStatus: string | null;
  subscriptionPlan: string | null;
  subscriptionCurrentPeriodEnd: string | null;
  billingEmail: string | null;
  accessEnabled: boolean;
}

const BILLING_COLUMNS =
  "id, name, first_name, last_name, stripe_customer_id, stripe_subscription_id, subscription_status, subscription_plan, subscription_current_period_end, billing_email, access_enabled";

type Row = Record<string, unknown>;

function rowToCompanyBilling(row: Row): CompanyBilling {
  return {
    id: row.id as string,
    name: row.name as string,
    firstName: (row.first_name as string | null) ?? null,
    lastName: (row.last_name as string | null) ?? null,
    stripeCustomerId: (row.stripe_customer_id as string | null) ?? null,
    stripeSubscriptionId: (row.stripe_subscription_id as string | null) ?? null,
    subscriptionStatus: (row.subscription_status as string | null) ?? null,
    subscriptionPlan: (row.subscription_plan as string | null) ?? null,
    subscriptionCurrentPeriodEnd: (row.subscription_current_period_end as string | null) ?? null,
    billingEmail: (row.billing_email as string | null) ?? null,
    accessEnabled: row.access_enabled === null || row.access_enabled === undefined ? true : Boolean(row.access_enabled),
  };
}

function metadataString(metadata: Record<string, unknown> | undefined, key: string): string | null {
  const value = metadata?.[key];
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

// Récupère la société de l'utilisateur connecté, ou la crée si c'est sa première
// connexion confirmée. Utilisée à la fois par le cockpit et par les routes de
// facturation : c'est le seul point de création d'une société, pour garder une
// seule logique.
//
// Prénom/nom/nom d'entreprise sont saisis au formulaire d'inscription et transitent
// via user_metadata (options.data du signUp) le temps que l'email soit confirmé —
// la ligne companies elle-même ne peut être créée qu'une fois la session active
// (RLS), donc à cette première connexion confirmée, jamais avant, jamais en double.
export async function getOrCreateCompanyForBilling(supabase: SupabaseClient, user: User): Promise<CompanyBilling> {
  const { data: existing, error: selectError } = await supabase
    .from("companies")
    .select(BILLING_COLUMNS)
    .eq("owner_id", user.id)
    .maybeSingle();
  if (selectError) throw selectError;
  if (existing) return rowToCompanyBilling(existing);

  const metadata = user.user_metadata as Record<string, unknown> | undefined;
  const firstName = metadataString(metadata, "first_name");
  const lastName = metadataString(metadata, "last_name");
  const companyName = metadataString(metadata, "company_name") ?? user.email ?? "Ma société";

  // access_enabled démarre à false pour toute nouvelle société : l'accès n'est
  // accordé qu'après un abonnement actif confirmé par le webhook Stripe. Les
  // sociétés déjà existantes gardent leur valeur actuelle (colonne "default true"
  // au niveau du schéma), donc aucune n'est bloquée rétroactivement.
  const { data: created, error: insertError } = await supabase
    .from("companies")
    .insert({
      owner_id: user.id,
      name: companyName,
      first_name: firstName,
      last_name: lastName,
      billing_email: user.email || null,
      access_enabled: false,
    })
    .select(BILLING_COLUMNS)
    .single();
  if (insertError) throw insertError;
  return rowToCompanyBilling(created);
}

export async function setStripeCustomerId(
  supabase: SupabaseClient,
  companyId: string,
  stripeCustomerId: string
): Promise<void> {
  const { error } = await supabase
    .from("companies")
    .update({ stripe_customer_id: stripeCustomerId })
    .eq("id", companyId);
  if (error) throw error;
}

// --- Côté webhook (client service_role, sans utilisateur connecté) ---

export async function findCompanyByStripeCustomerId(
  admin: SupabaseClient,
  stripeCustomerId: string
): Promise<CompanyBilling | null> {
  const { data, error } = await admin
    .from("companies")
    .select(BILLING_COLUMNS)
    .eq("stripe_customer_id", stripeCustomerId)
    .maybeSingle();
  if (error) throw error;
  return data ? rowToCompanyBilling(data) : null;
}

export async function findCompanyByStripeSubscriptionId(
  admin: SupabaseClient,
  stripeSubscriptionId: string
): Promise<CompanyBilling | null> {
  const { data, error } = await admin
    .from("companies")
    .select(BILLING_COLUMNS)
    .eq("stripe_subscription_id", stripeSubscriptionId)
    .maybeSingle();
  if (error) throw error;
  return data ? rowToCompanyBilling(data) : null;
}

export interface BillingUpdate {
  stripeCustomerId?: string;
  stripeSubscriptionId?: string;
  subscriptionStatus?: string;
  subscriptionPlan?: string;
  subscriptionCurrentPeriodEnd?: string | null;
  billingEmail?: string;
  accessEnabled?: boolean;
}

export async function updateCompanyBilling(
  admin: SupabaseClient,
  companyId: string,
  update: BillingUpdate
): Promise<void> {
  const patch: Row = {};
  if (update.stripeCustomerId !== undefined) patch.stripe_customer_id = update.stripeCustomerId;
  if (update.stripeSubscriptionId !== undefined) patch.stripe_subscription_id = update.stripeSubscriptionId;
  if (update.subscriptionStatus !== undefined) patch.subscription_status = update.subscriptionStatus;
  if (update.subscriptionPlan !== undefined) patch.subscription_plan = update.subscriptionPlan;
  if (update.subscriptionCurrentPeriodEnd !== undefined)
    patch.subscription_current_period_end = update.subscriptionCurrentPeriodEnd;
  if (update.billingEmail !== undefined) patch.billing_email = update.billingEmail;
  if (update.accessEnabled !== undefined) patch.access_enabled = update.accessEnabled;
  if (Object.keys(patch).length === 0) return;

  const { error } = await admin.from("companies").update(patch).eq("id", companyId);
  if (error) throw error;
}

// Statuts Stripe qui donnent accès à l'app pour cette première version.
const STATUTS_AVEC_ACCES = new Set(["active", "trialing"]);
const STATUTS_SANS_ACCES = new Set(["canceled", "incomplete_expired"]);

// past_due / unpaid et tout autre statut non listé : on ne change pas access_enabled
// (pas de blocage brutal pour cette première version, voir l'étape 8 du plan).
export function accessEnabledForStatus(status: string, current: boolean): boolean {
  if (STATUTS_AVEC_ACCES.has(status)) return true;
  if (STATUTS_SANS_ACCES.has(status)) return false;
  return current;
}
