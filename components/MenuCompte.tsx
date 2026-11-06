"use client";

import { KeyboardEvent, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";

interface MenuCompteProps {
  email: string | undefined;
  // Déconnexion existante de la page (supabase.auth.signOut) : la page réaffiche alors son écran de
  // connexion, comme avec l'ancien bouton « Se déconnecter ».
  onDeconnexion: () => unknown;
  // Côté où s'ouvre le menu : à droite quand l'e-mail est au bord droit de l'écran.
  alignement?: "gauche" | "droite";
}

// Menu de compte ouvert depuis l'adresse e-mail, partagé par tous les en-têtes qui l'affichent.
// Supabase n'a pas de sélecteur de comptes : « Changer de compte » ferme la session et ramène à
// l'écran de connexion du cockpit, où saisir un autre compte.
export default function MenuCompte({ email, onDeconnexion, alignement = "gauche" }: MenuCompteProps) {
  const router = useRouter();
  const [ouvert, setOuvert] = useState(false);
  const conteneurRef = useRef<HTMLDivElement>(null);
  const boutonRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!ouvert) return;
    const gererClicExterieur = (e: MouseEvent) => {
      if (conteneurRef.current && !conteneurRef.current.contains(e.target as Node)) setOuvert(false);
    };
    document.addEventListener("mousedown", gererClicExterieur);
    menuRef.current?.querySelector<HTMLButtonElement>('[role="menuitem"]')?.focus();
    return () => document.removeEventListener("mousedown", gererClicExterieur);
  }, [ouvert]);

  const fermer = (rendreFocus: boolean) => {
    setOuvert(false);
    if (rendreFocus) boutonRef.current?.focus();
  };

  const gererClavier = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key === "Escape") {
      e.preventDefault();
      fermer(true);
      return;
    }
    if (e.key === "Tab") {
      setOuvert(false);
      return;
    }
    if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
    e.preventDefault();
    const items = Array.from(menuRef.current?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]') ?? []);
    const courant = items.indexOf(document.activeElement as HTMLButtonElement);
    const pas = e.key === "ArrowDown" ? 1 : -1;
    items[(courant + pas + items.length) % items.length]?.focus();
  };

  const seDeconnecter = async () => {
    setOuvert(false);
    await onDeconnexion();
  };

  const changerDeCompte = async () => {
    setOuvert(false);
    await onDeconnexion();
    router.push("/");
  };

  return (
    <div className="menu-compte" ref={conteneurRef} onKeyDown={gererClavier}>
      <button
        ref={boutonRef}
        type="button"
        className="menu-compte__declencheur"
        aria-haspopup="menu"
        aria-expanded={ouvert}
        onClick={() => setOuvert((o) => !o)}
      >
        <span className="menu-compte__email">{email}</span>
        <span className="menu-compte__chevron" aria-hidden="true">
          ▾
        </span>
      </button>
      {ouvert && (
        <div
          ref={menuRef}
          role="menu"
          aria-label="Compte"
          className={`passe-filtre__popover menu-compte__menu${alignement === "droite" ? " menu-compte__menu--droite" : ""}`}
        >
          <button type="button" role="menuitem" className="menu-compte__item" onClick={changerDeCompte}>
            Changer de compte
          </button>
          <button type="button" role="menuitem" className="menu-compte__item" onClick={seDeconnecter}>
            Se déconnecter
          </button>
        </div>
      )}
    </div>
  );
}
