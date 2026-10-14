"use client";

import MentionTTC from "./MentionTTC";
import { MENTION_TTC } from "@/lib/format";
import { useState } from "react";
import {
  EcartCouts,
  EcartEbitda,
  EcartMarge,
  LIBELLE_EBITDA_INCOMPLET,
  libellesEcartCouts,
  libellesEcartEbitda,
  libellesEcartMarge,
  LibellesCible,
  StatutCible,
} from "@/lib/pastTargets";

// Couleur légère, pas un feu tricolore : vert quand c'est favorable, rose quand c'est défavorable,
// neutre dans la cible. Le sens (une marge au-dessus, des coûts en dessous) est décidé par
// lib/pastTargets.ts, jamais ici.
const CLASSES: Record<StatutCible, string> = {
  favorable: " passe-ecart--positif",
  defavorable: " passe-ecart--negatif",
  neutre: "",
  // Cible qui couvre trop peu du CA : pas de verdict, donc aucune couleur.
  incomplet: "",
};

/**
 * Ce que la cible couvre (« Cible calculée sur 99 % du CA »), en infobulle à côté d'elle plutôt
 * qu'en ligne permanente. Visible au survol et au focus clavier (CSS), et au toucher : le clic
 * l'ouvre et la referme, sans dépendre du focus — un bouton touché n'en reçoit pas partout.
 */
function InfoCible({ texte }: { texte: string }) {
  const [ouverte, setOuverte] = useState(false);
  return (
    <button
      type="button"
      className={`passe-cible__info${ouverte ? " passe-cible__info--ouverte" : ""}`}
      aria-label={texte}
      aria-expanded={ouverte}
      onClick={() => setOuverte((o) => !o)}
      onBlur={() => setOuverte(false)}
      onKeyDown={(e) => {
        if (e.key === "Escape") setOuverte(false);
      }}
    >
      <span aria-hidden="true">ⓘ</span>
      <span className="passe-cible__bulle" aria-hidden="true">
        {texte}
      </span>
    </button>
  );
}

interface PasseEcartCibleProps {
  ecart:
    | { type: "marge"; valeur: EcartMarge | null }
    | { type: "couts"; valeur: EcartCouts | null }
    // EBITDA : cible dérivée de la Marge contributive cible et des Coûts de structure cibles.
    // `incomplet` : une seule des deux est définie — pas de cible, et on le dit.
    | { type: "ebitda"; valeur: EcartEbitda | null; incomplet: boolean };
  // Fourni (onglet Général) : l'information est un lien vers l'écran de diagnostic, et l'absence
  // de cible invite à en définir une. Absent (écrans de détail) : simple lecture.
  onOuvrir?: () => void;
  onDefinir?: () => void;
  libelleLien?: string;
  // Le bloc parent affiche déjà la mention TTC pour ces montants : ne pas la répéter.
  sansMentionTTC?: boolean;
}

/** Cible et écart d'un indicateur : « Cible 44,0 % ⓘ · -27 k€ vs cible ». */
export default function PasseEcartCible({ ecart, onOuvrir, onDefinir, libelleLien, sansMentionTTC = false }: PasseEcartCibleProps) {
  if (ecart.valeur === null) {
    const incomplet = ecart.type === "ebitda" && ecart.incomplet;
    if (onDefinir) {
      return (
        <button type="button" className="passe-cible passe-cible--lien" onClick={onDefinir}>
          {incomplet ? `${LIBELLE_EBITDA_INCOMPLET} — compléter les objectifs` : "Définir une cible"}
        </button>
      );
    }
    return <p className="passe-cible">{incomplet ? LIBELLE_EBITDA_INCOMPLET : "Aucune cible définie"}</p>;
  }
  const libelles =
    ecart.type === "marge" ? libellesEcartMarge(ecart.valeur) : ecart.type === "couts" ? libellesEcartCouts(ecart.valeur) : libellesEcartEbitda(ecart.valeur);
  // Une seule mention TTC par ligne : devant la cible quand elle est en euros (elle vaut alors aussi
  // pour l'écart), sinon devant l'écart en euros (cible de marge en %).
  const mention = sansMentionTTC ? null : libelles.mentionTTC;
  const cible = (
    <span className="passe-cible__valeur">
      {mention === "cible" && <MentionTTC />}
      {libelles.cible}
    </span>
  );
  const info = libelles.reserve && <InfoCible texte={libelles.reserve} />;
  const valeurEcart = (
    <>
      <span aria-hidden="true">· </span>
      <span className={`passe-ecart${CLASSES[ecart.valeur.statut]}`}>
        {mention === "ecart" && <MentionTTC />}
        {libelles.ecart}
      </span>
    </>
  );
  if (!onOuvrir) {
    return (
      <p className="passe-cible">
        {cible}
        {info}
        {valeurEcart}
      </p>
    );
  }
  // Lien vers l'écran de diagnostic. L'infobulle est un bouton à part, entre la cible et l'écart :
  // la cible reste cliquable à la souris, et le clavier ne rencontre qu'un seul lien, sur l'écart.
  return (
    <div className="passe-cible passe-cible--lien">
      <button type="button" className="passe-cible__lien" tabIndex={-1} aria-hidden="true" onClick={onOuvrir}>
        {cible}
      </button>
      {info}
      <button type="button" className="passe-cible__lien" onClick={onOuvrir} aria-label={`${libelles.cible}, ${libelles.ecart}${mention ? ` (montants ${MENTION_TTC})` : ""}. ${libelleLien ?? "Voir le détail"}`}>
        {valeurEcart}
      </button>
    </div>
  );
}
