// Récupération du mot de passe (Supabase Auth, flux implicite — celui du client créé dans
// lib/supabaseClient.ts). Fonctions pures : aucune ne journalise ni ne renvoie de jeton hors de
// l'appelant.
//
// Comment le lien arrive :
// - Modèle d'e-mail par défaut ({{ .ConfirmationURL }}) : Supabase vérifie le lien puis redirige vers
//   `redirectTo` s'il est autorisé, sinon vers la Site URL — c'est le cas d'une récupération lancée
//   depuis le dashboard, qui arrive donc sur `/`. La session est dans le fragment :
//   `#access_token=…&refresh_token=…&type=recovery`.
// - Modèle personnalisé avec {{ .TokenHash }} : `?token_hash=…&type=recovery`, vérifié côté client
//   par verifyOtp.
// - Lien expiré ou déjà utilisé : `#error=access_denied&error_code=otp_expired&…`, sans `type`.

export const ROUTE_REINITIALISATION = "/reinitialiser-mot-de-passe";

// Même minimum que le formulaire de connexion et que le réglage par défaut de Supabase ; si le
// projet Supabase en exige davantage, son refus est affiché tel quel (messageErreurMiseAJour).
export const LONGUEUR_MIN_MOT_DE_PASSE = 6;

export type LienAuth =
  | { type: "recuperation-implicite"; accessToken: string }
  | { type: "recuperation-token-hash"; tokenHash: string }
  | { type: "erreur"; code: string | null }
  | { type: "aucun" };

function parametres(href: string): { url: URL; fragment: URLSearchParams } | null {
  try {
    const url = new URL(href);
    return { url, fragment: new URLSearchParams(url.hash.replace(/^#/, "")) };
  } catch {
    return null;
  }
}

export function lireLienAuth(href: string | null | undefined): LienAuth {
  const p = href ? parametres(href) : null;
  if (!p) return { type: "aucun" };
  const { url, fragment } = p;
  const lire = (cle: string) => fragment.get(cle) ?? url.searchParams.get(cle);

  if (lire("error") || lire("error_code") || lire("error_description")) {
    return { type: "erreur", code: lire("error_code") };
  }
  if (lire("type") !== "recovery") return { type: "aucun" };

  const accessToken = fragment.get("access_token");
  if (accessToken) return { type: "recuperation-implicite", accessToken };
  const tokenHash = url.searchParams.get("token_hash");
  if (tokenHash) return { type: "recuperation-token-hash", tokenHash };
  return { type: "aucun" };
}

// Un lien de récupération arrivé ailleurs que sur l'écran dédié (la Site URL `/` pour une
// récupération lancée depuis le dashboard) y est renvoyé, paramètres compris. Rien sinon.
export function redirectionVersReinitialisation(href: string | null | undefined): string | null {
  const lien = lireLienAuth(href);
  if (lien.type !== "recuperation-implicite" && lien.type !== "recuperation-token-hash") return null;
  const p = parametres(href!);
  if (!p || p.url.pathname === ROUTE_REINITIALISATION) return null;
  return `${ROUTE_REINITIALISATION}${p.url.search}${p.url.hash}`;
}

export function messageLienInvalide(code: string | null | undefined): string {
  if (code === "otp_expired") {
    return "Ce lien a expiré ou a déjà été utilisé. Demandez un nouveau lien ci-dessous.";
  }
  return "Ce lien de réinitialisation n'est pas valide. Demandez un nouveau lien ci-dessous.";
}

export function verifierNouveauMotDePasse(motDePasse: string, confirmation: string): string | null {
  if (motDePasse.length < LONGUEUR_MIN_MOT_DE_PASSE) {
    return `Le mot de passe doit contenir au moins ${LONGUEUR_MIN_MOT_DE_PASSE} caractères.`;
  }
  if (motDePasse !== confirmation) return "Les deux mots de passe ne sont pas identiques.";
  return null;
}

// Refus de Supabase à la mise à jour. Le message brut de Supabase (en anglais) n'est repris que
// pour la politique de mot de passe, dont il décrit les exigences du projet.
export function messageErreurMiseAJour(erreur: { code?: string; status?: number; message?: string }): string {
  if (erreur.code === "same_password") {
    return "Le nouveau mot de passe doit être différent de l'ancien.";
  }
  if (erreur.code === "weak_password") {
    return `Ce mot de passe est trop faible. ${erreur.message ?? ""}`.trim();
  }
  if (erreur.status === 401 || erreur.status === 403 || erreur.code === "session_not_found" || erreur.code === "bad_jwt") {
    return "Votre lien a expiré. Demandez un nouveau lien de réinitialisation.";
  }
  return "Impossible d'enregistrer le mot de passe pour le moment. Veuillez réessayer.";
}

// Réponse unique à une demande de lien, que l'adresse soit enregistrée ou non, et même si Supabase
// refuse la demande (limite d'envoi par adresse : la signaler révélerait que le compte existe).
export const MESSAGE_DEMANDE_ENVOYEE =
  "Si un compte Novanta est associé à cette adresse, vous allez recevoir un e-mail contenant un lien pour réinitialiser votre mot de passe. Pensez à vérifier vos courriers indésirables.";
