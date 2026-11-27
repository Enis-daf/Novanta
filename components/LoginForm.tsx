"use client";

import { FormEvent, useEffect, useState } from "react";
import DemandeReinitialisation from "@/components/DemandeReinitialisation";
import { supabase, urlAuChargement } from "@/lib/supabaseClient";
import { lireLienAuth } from "@/lib/recuperationMotDePasse";

export default function LoginForm() {
  const [mode, setMode] = useState<"connexion" | "creation" | "oubli">("connexion");
  const [prenom, setPrenom] = useState("");
  const [nom, setNom] = useState("");
  const [entreprise, setEntreprise] = useState("");
  const [email, setEmail] = useState("");
  const [motDePasse, setMotDePasse] = useState("");
  const [erreur, setErreur] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);
  const [enCours, setEnCours] = useState(false);

  // Lien d'e-mail expiré ou déjà utilisé arrivé sur la Site URL (le fragment d'erreur ne dit pas de
  // quel lien il s'agit) : sans ce message, l'utilisateur retombait sur la connexion sans explication.
  useEffect(() => {
    if (lireLienAuth(urlAuChargement).type === "erreur") {
      setErreur(
        "Ce lien a expiré ou a déjà été utilisé. Pour réinitialiser votre mot de passe, cliquez sur « Mot de passe oublié ? ».",
      );
    }
  }, []);

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setErreur(null);
    setInfo(null);

    if (mode === "connexion") {
      setEnCours(true);
      const { error } = await supabase!.auth.signInWithPassword({ email, password: motDePasse });
      if (error) setErreur(error.message);
      setEnCours(false);
      return;
    }

    const prenomNettoye = prenom.trim();
    const nomNettoye = nom.trim();
    const entrepriseNettoyee = entreprise.trim();

    if (!prenomNettoye || !nomNettoye || !entrepriseNettoyee) {
      setErreur("Prénom, nom et entreprise sont obligatoires.");
      return;
    }

    setEnCours(true);
    const { data, error } = await supabase!.auth.signUp({
      email,
      password: motDePasse,
      options: {
        data: {
          first_name: prenomNettoye,
          last_name: nomNettoye,
          company_name: entrepriseNettoyee,
        },
      },
    });
    if (error) {
      setErreur(error.message);
    } else if (!data.session) {
      setInfo("Compte créé. Vérifiez votre email pour confirmer votre compte avant de vous connecter.");
    }
    setEnCours(false);
  };

  if (mode === "oubli") {
    return (
      <main className="ecran-editorial">
        <div className="carte-editoriale login-card">
          <p className="eyebrow">
            Novanta
            <span className="carte-editoriale__rubrique">Mot de passe oublié</span>
          </p>
          <h1>Cockpit de trésorerie</h1>
          <p className="login-subtitle">Recevez un lien pour choisir un nouveau mot de passe</p>
          <DemandeReinitialisation emailInitial={email} />
          <button
            type="button"
            className="login-toggle"
            onClick={() => {
              setMode("connexion");
              setErreur(null);
              setInfo(null);
            }}
          >
            Retour à la connexion
          </button>
        </div>
      </main>
    );
  }

  return (
    <main className="ecran-editorial">
      <form className="carte-editoriale login-card" onSubmit={handleSubmit}>
        <p className="eyebrow">
          Novanta
          <span className="carte-editoriale__rubrique">{mode === "connexion" ? "Connexion" : "Création de compte"}</span>
        </p>
        <h1>Cockpit de trésorerie</h1>
        <p className="login-subtitle">
          {mode === "connexion" ? "Connectez-vous à votre société" : "Créez votre compte"}
        </p>

        {mode === "creation" && (
          <>
            <label htmlFor="login-prenom">Prénom</label>
            <input
              id="login-prenom"
              type="text"
              required
              value={prenom}
              onChange={(e) => setPrenom(e.target.value)}
            />

            <label htmlFor="login-nom">Nom</label>
            <input id="login-nom" type="text" required value={nom} onChange={(e) => setNom(e.target.value)} />

            <label htmlFor="login-entreprise">Entreprise</label>
            <input
              id="login-entreprise"
              type="text"
              required
              value={entreprise}
              onChange={(e) => setEntreprise(e.target.value)}
            />
          </>
        )}

        <label htmlFor="login-email">Email</label>
        <input
          id="login-email"
          type="email"
          required
          value={email}
          onChange={(e) => setEmail(e.target.value)}
        />

        <label htmlFor="login-password">Mot de passe</label>
        <input
          id="login-password"
          type="password"
          required
          minLength={6}
          value={motDePasse}
          onChange={(e) => setMotDePasse(e.target.value)}
        />

        {mode === "connexion" && (
          <button
            type="button"
            className="login-toggle login-oubli"
            onClick={() => {
              setMode("oubli");
              setErreur(null);
              setInfo(null);
            }}
          >
            Mot de passe oublié ?
          </button>
        )}

        {erreur && <div className="login-erreur">{erreur}</div>}
        {info && <div className="login-info">{info}</div>}

        <button type="submit" className="btn-add" disabled={enCours}>
          {mode === "connexion" ? "Se connecter" : "Créer mon compte"}
        </button>

        <button
          type="button"
          className="login-toggle"
          onClick={() => {
            setMode(mode === "connexion" ? "creation" : "connexion");
            setErreur(null);
            setInfo(null);
          }}
        >
          {mode === "connexion" ? "Pas encore de compte ? En créer un" : "Déjà un compte ? Se connecter"}
        </button>
      </form>
    </main>
  );
}
