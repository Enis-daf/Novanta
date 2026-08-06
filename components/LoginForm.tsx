"use client";

import { FormEvent, useState } from "react";
import { supabase } from "@/lib/supabaseClient";

export default function LoginForm() {
  const [mode, setMode] = useState<"connexion" | "creation">("connexion");
  const [prenom, setPrenom] = useState("");
  const [nom, setNom] = useState("");
  const [entreprise, setEntreprise] = useState("");
  const [email, setEmail] = useState("");
  const [motDePasse, setMotDePasse] = useState("");
  const [erreur, setErreur] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);
  const [enCours, setEnCours] = useState(false);

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

  return (
    <main className="login-screen">
      <form className="login-card" onSubmit={handleSubmit}>
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
