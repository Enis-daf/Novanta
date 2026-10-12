"use client";

import { EcartCouts, EcartMarge, libellesEcartCouts, libellesEcartMarge, LibellesCible, StatutCible } from "@/lib/pastTargets";

// Couleur légère, pas un feu tricolore : vert quand c'est favorable, rose quand c'est défavorable,
// neutre dans la cible. Le sens (une marge au-dessus, des coûts en dessous) est décidé par
// lib/pastTargets.ts, jamais ici.
const CLASSES: Record<StatutCible, string> = {
  favorable: " passe-ecart--positif",
  defavorable: " passe-ecart--negatif",
  neutre: "",
  // Cible qui couvre trop peu du CA : l'écart est indicatif, il ne prend aucune couleur.
  incomplet: "",
};

function Contenu({ libelles, statut }: { libelles: LibellesCible; statut: StatutCible }) {
  return (
    <>
      <span className="passe-cible__valeur">{libelles.cible}</span>
      <span className={`passe-ecart${CLASSES[statut]}`}>{libelles.ecart}</span>
      {libelles.reserve && <span className="passe-cible__reserve">{libelles.reserve}</span>}
    </>
  );
}

interface PasseEcartCibleProps {
  ecart: { type: "marge"; valeur: EcartMarge | null } | { type: "couts"; valeur: EcartCouts | null };
  // Fourni (onglet Général) : l'information est un lien vers l'écran de diagnostic, et l'absence
  // de cible invite à en définir une. Absent (écrans de détail) : simple lecture.
  onOuvrir?: () => void;
  onDefinir?: () => void;
  libelleLien?: string;
}

/** Cible et écart d'un indicateur : « Cible 44,0 % · -3,8 pts · -27 k€ vs cible ». */
export default function PasseEcartCible({ ecart, onOuvrir, onDefinir, libelleLien }: PasseEcartCibleProps) {
  if (ecart.valeur === null) {
    if (onDefinir) {
      return (
        <button type="button" className="passe-cible passe-cible--lien" onClick={onDefinir}>
          Définir une cible
        </button>
      );
    }
    return <p className="passe-cible">Aucune cible définie</p>;
  }
  const libelles = ecart.type === "marge" ? libellesEcartMarge(ecart.valeur) : libellesEcartCouts(ecart.valeur);
  const contenu = <Contenu libelles={libelles} statut={ecart.valeur.statut} />;
  return onOuvrir ? (
    <button type="button" className="passe-cible passe-cible--lien" onClick={onOuvrir} aria-label={`${libelles.cible}, ${libelles.ecart}. ${libelleLien ?? "Voir le détail"}`}>
      {contenu}
    </button>
  ) : (
    <p className="passe-cible">{contenu}</p>
  );
}
