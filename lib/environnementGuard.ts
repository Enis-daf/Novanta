/**
 * Garde-fou d'environnement : empêche l'environnement de test (« QANNT TEST — STAGING ») de se
 * brancher par accident sur une autre base Supabase que celle du staging.
 *
 * Inactif tant que NEXT_PUBLIC_NOVANTA_ENV ne vaut pas "staging" : en Production et en Preview,
 * où cette variable n'existe pas, ce module ne change strictement rien.
 *
 * En mode staging, tout client Supabase (navigateur, serveur utilisateur, service_role) et tout
 * script de test passe par exigerEnvironnementSur() avant de se connecter. La connexion est
 * refusée si :
 *  - la ref staging attendue n'est pas déclarée ;
 *  - la ref du projet visé n'est pas exactement la ref staging attendue (allowlist) ;
 *  - la ref du projet visé figure parmi les refs interdites (toute base qui n'est pas le staging) ;
 *  - une clé Supabase au format JWT appartient à un autre projet que le staging.
 *
 * Les refs de projet Supabase ne sont pas des secrets (elles figurent dans l'URL publique) :
 * elles peuvent donc être lues côté navigateur et citées dans un message d'erreur. Aucune clé
 * n'est jamais citée.
 */

export const MODE_STAGING = "staging";

export interface ConfigEnvironnement {
  mode: string | undefined;
  supabaseUrl: string | undefined;
  refStagingAttendue: string | undefined;
  refsInterdites: string | undefined; // refs séparées par des virgules
  cles: (string | undefined)[]; // clés Supabase à contrôler (publishable, service_role)
}

export type VerdictEnvironnement = { ok: true; staging: boolean } | { ok: false; raison: string };

const FORMAT_REF = /^[a-z0-9]{15,30}$/;

/** "https://<ref>.supabase.co" -> "<ref>" ; null pour toute autre forme d'URL. */
export function refDepuisUrlSupabase(url: string | undefined | null): string | null {
  if (!url) return null;
  let hote: string;
  try {
    hote = new URL(url).hostname.toLowerCase();
  } catch {
    return null;
  }
  const correspondance = hote.match(/^([a-z0-9]+)\.supabase\.(co|in|net)$/);
  return correspondance ? correspondance[1] : null;
}

/**
 * Ref du projet inscrite dans une clé Supabase au format JWT (champ "ref" du payload). null si la
 * clé n'est pas un JWT (nouveau format "sb_publishable_..." / "sb_secret_...") ou est illisible :
 * dans ce cas la clé ne peut pas être contrôlée, seule l'URL fait foi.
 */
export function refDepuisCleSupabase(cle: string | undefined | null): string | null {
  if (!cle) return null;
  const parties = cle.trim().split(".");
  if (parties.length !== 3) return null;
  try {
    const base64 = parties[1].replace(/-/g, "+").replace(/_/g, "/");
    const payload = JSON.parse(atob(base64.padEnd(Math.ceil(base64.length / 4) * 4, "="))) as { ref?: unknown };
    return typeof payload.ref === "string" ? payload.ref : null;
  } catch {
    return null;
  }
}

/**
 * Ref du projet visé par une chaîne de connexion Postgres Supabase, sous ses deux formes :
 *  - connexion directe : hôte "db.<ref>.supabase.co" ;
 *  - pooler : utilisateur "postgres.<ref>" sur "*.pooler.supabase.com".
 * Ne renvoie jamais la chaîne ni le mot de passe.
 */
export function refDepuisUrlPostgres(url: string | undefined | null): string | null {
  if (!url) return null;
  let analysee: URL;
  try {
    analysee = new URL(url);
  } catch {
    return null;
  }
  const hote = analysee.hostname.toLowerCase();
  const direct = hote.match(/^db\.([a-z0-9]+)\.supabase\.(co|in|net)$/);
  if (direct) return direct[1];
  if (hote.endsWith(".pooler.supabase.com")) {
    const utilisateur = decodeURIComponent(analysee.username).toLowerCase();
    const pooler = utilisateur.match(/^postgres\.([a-z0-9]+)$/);
    if (pooler) return pooler[1];
  }
  return null;
}

function listeRefs(brut: string | undefined): string[] {
  return (brut ?? "")
    .split(",")
    .map((ref) => ref.trim().toLowerCase())
    .filter(Boolean);
}

/**
 * Contrôle commun à une ref déjà extraite (URL d'API ou chaîne Postgres) : allowlist stricte de la
 * ref staging, puis refus explicite des refs interdites.
 */
export function verifierRefCible(
  refCible: string | null,
  refStagingAttendue: string | undefined,
  refsInterdites: string | undefined
): VerdictEnvironnement {
  const attendue = (refStagingAttendue ?? "").trim().toLowerCase();
  if (!FORMAT_REF.test(attendue)) {
    return { ok: false, raison: "NEXT_PUBLIC_STAGING_SUPABASE_REF est absente ou mal formée." };
  }
  const interdites = listeRefs(refsInterdites);
  if (interdites.includes(attendue)) {
    return { ok: false, raison: `La ref staging déclarée (${attendue}) figure parmi les refs interdites.` };
  }
  if (!refCible) {
    return { ok: false, raison: "Impossible de déterminer le projet Supabase visé." };
  }
  if (interdites.includes(refCible)) {
    return { ok: false, raison: `Le projet visé (${refCible}) figure parmi les refs interdites.` };
  }
  if (refCible !== attendue) {
    return { ok: false, raison: `Le projet visé (${refCible}) n'est pas le staging attendu (${attendue}).` };
  }
  return { ok: true, staging: true };
}

export function verifierEnvironnement(config: ConfigEnvironnement): VerdictEnvironnement {
  if (config.mode !== MODE_STAGING) return { ok: true, staging: false };

  const verdict = verifierRefCible(refDepuisUrlSupabase(config.supabaseUrl), config.refStagingAttendue, config.refsInterdites);
  if (!verdict.ok) return verdict;

  const attendue = (config.refStagingAttendue ?? "").trim().toLowerCase();
  for (const cle of config.cles) {
    const refCle = refDepuisCleSupabase(cle);
    if (refCle !== null && refCle !== attendue) {
      return { ok: false, raison: `Une clé Supabase appartient au projet ${refCle}, pas au staging attendu (${attendue}).` };
    }
  }
  return verdict;
}

// Accès statiques obligatoires : Next.js n'injecte une variable NEXT_PUBLIC_ dans le bundle
// navigateur que si elle est lue littéralement sous la forme process.env.NEXT_PUBLIC_XXX.
function configDepuisProcessEnv(clesSupplementaires: (string | undefined)[]): ConfigEnvironnement {
  return {
    mode: process.env.NEXT_PUBLIC_NOVANTA_ENV,
    supabaseUrl: process.env.NEXT_PUBLIC_SUPABASE_URL,
    refStagingAttendue: process.env.NEXT_PUBLIC_STAGING_SUPABASE_REF,
    refsInterdites: process.env.NEXT_PUBLIC_NOVANTA_FORBIDDEN_SUPABASE_REFS,
    cles: [process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY, ...clesSupplementaires],
  };
}

export function estModeStaging(): boolean {
  return process.env.NEXT_PUBLIC_NOVANTA_ENV === MODE_STAGING;
}

/**
 * À appeler avant toute création de client Supabase. Sans effet hors mode staging. En mode
 * staging, lève une erreur — donc aucune connexion, aucune lecture, aucune écriture — si la
 * configuration ne désigne pas sans ambiguïté le projet staging.
 */
export function exigerEnvironnementSur(clesSupplementaires: (string | undefined)[] = []): void {
  const verdict = verifierEnvironnement(configDepuisProcessEnv(clesSupplementaires));
  if (!verdict.ok) {
    throw new Error(`[garde-fou staging] Connexion Supabase refusée : ${verdict.raison}`);
  }
}
