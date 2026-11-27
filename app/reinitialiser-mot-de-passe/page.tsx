"use client";

import { FormEvent, useEffect, useState } from "react";
import DemandeReinitialisation from "@/components/DemandeReinitialisation";
import { supabase, supabaseConfigured, urlAuChargement } from "@/lib/supabaseClient";
import { quitterLaSession } from "@/lib/atterrissageSession";
import {
  LONGUEUR_MIN_MOT_DE_PASSE,
  ROUTE_REINITIALISATION,
  lireLienAuth,
  messageErreurMiseAJour,
  messageLienInvalide,
  verifierNouveauMotDePasse,
} from "@/lib/recuperationMotDePasse";

type Etat =
  | { etape: "verification" }
  | { etape: "formulaire" }
  | { etape: "lien-invalide"; message: string }
  | { etape: "enregistre" };

// Écran d'arrivée du lien de récupération. Le formulaire n'est proposé que si CE chargement a
// vérifié un lien de récupération : une session ouverte autrement (connexion ordinaire, autre
// compte dans le même navigateur) ne permet pas d'y changer le mot de passe.
export default function ReinitialiserMotDePassePage() {
  const [etat, setEtat] = useState<Etat>({ etape: "verification" });
  const [motDePasse, setMotDePasse] = useState("");
  const [confirmation, setConfirmation] = useState("");
  const [erreur, setErreur] = useState<string | null>(null);
  const [enCours, setEnCours] = useState(false);

  useEffect(() => {
    if (!supabaseConfigured) {
      setEtat({ etape: "lien-invalide", message: "La réinitialisation est indisponible pour le moment." });
      return;
    }
    let annule = false;
    const conclure = (suivant: Etat) => {
      if (!annule) setEtat(suivant);
    };

    const verifier = async () => {
      const lien = lireLienAuth(urlAuChargement);

      if (lien.type === "erreur") {
        conclure({ etape: "lien-invalide", message: messageLienInvalide(lien.code) });
        return;
      }

      if (lien.type === "recuperation-token-hash") {
        // Le jeton ne reste pas dans la barre d'adresse ni dans l'historique.
        window.history.replaceState(null, "", ROUTE_REINITIALISATION);
        const { data, error } = await supabase!.auth.verifyOtp({ token_hash: lien.tokenHash, type: "recovery" });
        conclure(
          error || !data.session
            ? { etape: "lien-invalide", message: messageLienInvalide(error?.code) }
            : { etape: "formulaire" },
        );
        return;
      }

      if (lien.type === "recuperation-implicite") {
        // getSession attend que le client ait lu et vérifié la session du fragment (getUser côté
        // Supabase). On exige que la session obtenue soit bien celle du lien : si la vérification a
        // échoué, getSession pourrait renvoyer une session antérieure du navigateur.
        const { data, error } = await supabase!.auth.getSession();
        const sessionDuLien = !error && data.session?.access_token === lien.accessToken;
        conclure(sessionDuLien ? { etape: "formulaire" } : { etape: "lien-invalide", message: messageLienInvalide(null) });
        return;
      }

      conclure({
        etape: "lien-invalide",
        message: "Pour réinitialiser votre mot de passe, ouvrez le lien reçu par e-mail ou demandez-en un nouveau.",
      });
    };

    verifier().catch(() => conclure({ etape: "lien-invalide", message: messageLienInvalide(null) }));
    return () => {
      annule = true;
    };
  }, []);

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setErreur(null);
    const invalide = verifierNouveauMotDePasse(motDePasse, confirmation);
    if (invalide) {
      setErreur(invalide);
      return;
    }
    setEnCours(true);
    // Seul le mot de passe est transmis : identifiant, e-mail, métadonnées, société et abonnement
    // ne sont pas touchés.
    const { error } = await supabase!.auth.updateUser({ password: motDePasse });
    if (error) {
      setErreur(messageErreurMiseAJour(error));
      setEnCours(false);
      return;
    }
    // La session de récupération est fermée sur ce navigateur : l'utilisateur se reconnecte avec
    // son nouveau mot de passe, et arrive comme à toute nouvelle connexion (atterrissageSession).
    await supabase!.auth.signOut({ scope: "local" });
    quitterLaSession();
    setMotDePasse("");
    setConfirmation("");
    setEnCours(false);
    setEtat({ etape: "enregistre" });
  };

  return (
    <main className="ecran-editorial">
      <div className="carte-editoriale login-card">
        <p className="eyebrow">
          Novanta
          <span className="carte-editoriale__rubrique">Mot de passe</span>
        </p>
        <h1>Réinitialiser votre mot de passe</h1>

        {etat.etape === "verification" && <p className="login-subtitle">Vérification du lien…</p>}

        {etat.etape === "formulaire" && (
          <form className="reinitialisation-formulaire" onSubmit={handleSubmit}>
            <label htmlFor="reinit-mdp">Nouveau mot de passe</label>
            <input
              id="reinit-mdp"
              type="password"
              required
              minLength={LONGUEUR_MIN_MOT_DE_PASSE}
              autoComplete="new-password"
              value={motDePasse}
              onChange={(e) => setMotDePasse(e.target.value)}
            />
            <label htmlFor="reinit-confirmation">Confirmer le mot de passe</label>
            <input
              id="reinit-confirmation"
              type="password"
              required
              autoComplete="new-password"
              value={confirmation}
              onChange={(e) => setConfirmation(e.target.value)}
            />
            {erreur && (
              <div className="login-erreur" role="alert">
                {erreur}
              </div>
            )}
            <button type="submit" className="btn-add" disabled={enCours}>
              Enregistrer mon nouveau mot de passe
            </button>
          </form>
        )}

        {etat.etape === "enregistre" && (
          <>
            <div className="login-info" role="status">
              Votre mot de passe a bien été modifié. Vous pouvez maintenant vous connecter avec votre nouveau mot de
              passe.
            </div>
            <a className="btn-add reinitialisation-lien" href="/">
              Se connecter
            </a>
          </>
        )}

        {etat.etape === "lien-invalide" && (
          <>
            <div className="login-erreur" role="alert">
              {etat.message}
            </div>
            {supabaseConfigured && <DemandeReinitialisation />}
            <a className="login-toggle" href="/">
              Retour à la connexion
            </a>
          </>
        )}
      </div>
    </main>
  );
}
