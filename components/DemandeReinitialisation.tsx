"use client";

import { FormEvent, useState } from "react";
import { supabase } from "@/lib/supabaseClient";
import { MESSAGE_DEMANDE_ENVOYEE, ROUTE_REINITIALISATION } from "@/lib/recuperationMotDePasse";

// Demande d'un lien de réinitialisation. La réponse affichée est toujours la même, que l'adresse
// soit enregistrée ou non (lib/recuperationMotDePasse.ts, MESSAGE_DEMANDE_ENVOYEE).
export default function DemandeReinitialisation({ emailInitial = "" }: { emailInitial?: string }) {
  const [email, setEmail] = useState(emailInitial);
  const [envoyee, setEnvoyee] = useState(false);
  const [enCours, setEnCours] = useState(false);

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setEnCours(true);
    try {
      // Résultat volontairement ignoré : aucune différence visible entre adresse connue, inconnue
      // ou limitée en envoi. Le lien revient sur l'écran dédié de l'environnement courant
      // (production, Preview, local) s'il figure dans les Redirect URLs, sinon sur la Site URL,
      // d'où lib/supabaseClient.ts le renvoie vers l'écran dédié.
      await supabase!.auth.resetPasswordForEmail(email.trim(), {
        redirectTo: `${window.location.origin}${ROUTE_REINITIALISATION}`,
      });
    } catch {
      // Réseau indisponible : même réponse, l'utilisateur pourra redemander un lien.
    }
    setEnvoyee(true);
    setEnCours(false);
  };

  if (envoyee) {
    return (
      <div className="login-info" role="status">
        {MESSAGE_DEMANDE_ENVOYEE}
      </div>
    );
  }

  return (
    <form className="demande-reinitialisation" onSubmit={handleSubmit}>
      <label htmlFor="reinit-email">Email</label>
      <input
        id="reinit-email"
        type="email"
        required
        autoComplete="email"
        value={email}
        onChange={(e) => setEmail(e.target.value)}
      />
      <button type="submit" className="btn-add" disabled={enCours}>
        Recevoir un lien de réinitialisation
      </button>
    </form>
  );
}
