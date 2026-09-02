"use client";

import { useEffect, useState } from "react";
import type { Session } from "@supabase/supabase-js";

interface PennylaneIntegrationProps {
  session: Session;
}

interface StatutPennylane {
  connected: boolean;
  status: "connected" | "invalid" | null;
  lastTestedAt: string | null;
  lastErrorCode: string | null;
}

async function appelerRoutePennylane(route: string, session: Session, body?: unknown): Promise<Record<string, unknown>> {
  const res = await fetch(route, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${session.access_token}`,
      ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  const data = await res.json();
  if (!res.ok) throw new Error((data.error as string) || "Une erreur est survenue.");
  return data;
}

function formatDateHeure(iso: string | null): string | null {
  if (!iso) return null;
  return new Date(iso).toLocaleString("fr-FR", { dateStyle: "medium", timeStyle: "short" });
}

// Section d'intégration Pennylane (MVP Company API Token) : remplace, quand elle est connectée, le
// besoin d'importer manuellement un fichier .xlsx pour "Identifier mes charges fixes" et
// "Vérifier mes données" — le token lui-même n'est jamais renvoyé au navigateur après sauvegarde,
// seul l'état {connected, lastTestedAt, lastErrorCode} est lisible ici.
export default function PennylaneIntegration({ session }: PennylaneIntegrationProps) {
  const [statut, setStatut] = useState<StatutPennylane | null>(null);
  const [chargement, setChargement] = useState(true);
  const [afficherFormulaire, setAfficherFormulaire] = useState(false);
  const [token, setToken] = useState("");
  const [actionEnCours, setActionEnCours] = useState<"connect" | "test" | "disconnect" | null>(null);
  const [erreur, setErreur] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);

  const chargerStatut = async () => {
    try {
      const res = await fetch("/api/pennylane/status", {
        headers: { Authorization: `Bearer ${session.access_token}` },
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Impossible de charger l'état de la connexion Pennylane.");
      const nouveauStatut = data as StatutPennylane;
      setStatut(nouveauStatut);
      // Jamais connecté, ou connexion devenue invalide : le formulaire de saisie du token doit
      // être immédiatement visible, l'utilisateur doit agir.
      if (!nouveauStatut.connected) setAfficherFormulaire(true);
      return nouveauStatut;
    } catch (error) {
      setErreur(error instanceof Error ? error.message : "Impossible de charger l'état de la connexion Pennylane.");
      return null;
    }
  };

  useEffect(() => {
    setChargement(true);
    chargerStatut().finally(() => setChargement(false));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handleConnecterTester = async () => {
    setErreur(null);
    setInfo(null);
    if (!token.trim()) {
      setErreur("Le token Pennylane est requis.");
      return;
    }
    setActionEnCours("connect");
    try {
      await appelerRoutePennylane("/api/pennylane/connect", session, { token: token.trim() });
      setToken("");
      setInfo("Pennylane connecté");
      setAfficherFormulaire(false);
      await chargerStatut();
    } catch (error) {
      setErreur(
        error instanceof Error ? error.message : "Connexion Pennylane impossible. Vérifiez le token et ses autorisations."
      );
    } finally {
      setActionEnCours(null);
    }
  };

  const handleTesterConnexionExistante = async () => {
    setErreur(null);
    setInfo(null);
    setActionEnCours("test");
    try {
      const data = await appelerRoutePennylane("/api/pennylane/test", session);
      if (data.connected) {
        setInfo("Pennylane connecté");
      } else {
        setErreur((data.error as string) || "Connexion Pennylane impossible. Vérifiez le token et ses autorisations.");
      }
      await chargerStatut();
    } catch (error) {
      setErreur(error instanceof Error ? error.message : "Impossible de tester la connexion Pennylane.");
    } finally {
      setActionEnCours(null);
    }
  };

  const handleDeconnecter = async () => {
    setErreur(null);
    setInfo(null);
    setActionEnCours("disconnect");
    try {
      await appelerRoutePennylane("/api/pennylane/disconnect", session);
      setToken("");
      await chargerStatut();
    } catch (error) {
      setErreur(error instanceof Error ? error.message : "Impossible de déconnecter Pennylane.");
    } finally {
      setActionEnCours(null);
    }
  };

  if (chargement) {
    return (
      <div className="billing-card">
        <h1>Pennylane</h1>
        <p>Chargement…</p>
      </div>
    );
  }

  const estConnecte = statut?.connected ?? false;
  const etaitConnecteMaisInvalide = statut?.status === "invalid";
  const derniereUtilisation = formatDateHeure(statut?.lastTestedAt ?? null);

  return (
    <div className="billing-card">
      <h1>Pennylane</h1>

      {erreur && <div className="login-erreur">{erreur}</div>}
      {info && <div className="login-info">{info}</div>}

      {estConnecte && (
        <p className="pennylane-badge pennylane-badge--connecte">🟢 Connecté</p>
      )}
      {estConnecte && derniereUtilisation && (
        <dl className="billing-status">
          <dt>Dernière utilisation</dt>
          <dd>{derniereUtilisation}</dd>
        </dl>
      )}

      {estConnecte && !afficherFormulaire && (
        <div className="billing-actions">
          <button
            type="button"
            className="btn-secondaire"
            onClick={handleTesterConnexionExistante}
            disabled={actionEnCours !== null}
          >
            {actionEnCours === "test" ? "Test en cours…" : "Tester la connexion"}
          </button>
          <button
            type="button"
            className="btn-secondaire"
            onClick={() => setAfficherFormulaire(true)}
            disabled={actionEnCours !== null}
          >
            Remplacer le token
          </button>
          <button type="button" className="btn-deconnexion" onClick={handleDeconnecter} disabled={actionEnCours !== null}>
            {actionEnCours === "disconnect" ? "Déconnexion…" : "Déconnecter Pennylane"}
          </button>
        </div>
      )}

      {!estConnecte && !afficherFormulaire && (
        <>
          <p>
            Connectez Pennylane pour utiliser automatiquement vos transactions bancaires dans Novanta, sans import
            manuel de fichier Excel.
          </p>
          <button type="button" className="btn-add" onClick={() => setAfficherFormulaire(true)}>
            Connecter Pennylane
          </button>
        </>
      )}

      {afficherFormulaire && (
        <>
          {etaitConnecteMaisInvalide && (
            <p>La connexion Pennylane n&apos;est plus valide. Remplacez votre token pour continuer.</p>
          )}
          <p className="pennylane-aide">
            Créez un token dans Pennylane (Paramètres → Développeurs → Générer un token API) avec un accès en
            lecture aux transactions bancaires, puis collez-le ci-dessous.
          </p>
          <div className="pennylane-champ">
            <label htmlFor="pennylane-token">Token API Pennylane</label>
            <input
              id="pennylane-token"
              type="password"
              value={token}
              onChange={(e) => setToken(e.target.value)}
              autoComplete="off"
              placeholder="••••••••••••••••"
            />
          </div>
          <div className="billing-actions">
            <button type="button" className="btn-add" onClick={handleConnecterTester} disabled={actionEnCours !== null}>
              {actionEnCours === "connect" ? "Test en cours…" : "Tester la connexion"}
            </button>
            {estConnecte && (
              <button
                type="button"
                className="btn-secondaire"
                onClick={() => {
                  setAfficherFormulaire(false);
                  setToken("");
                  setErreur(null);
                }}
                disabled={actionEnCours !== null}
              >
                Annuler
              </button>
            )}
          </div>
        </>
      )}
    </div>
  );
}
