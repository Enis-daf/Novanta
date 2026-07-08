"use client";

import { useEffect, useRef, useState } from "react";
import { estDateValide, parseDateISO, toISODate } from "@/lib/dates";

interface DateFieldProps {
  id?: string;
  value: string; // "" = vide
  onChange: (value: string) => void;
  className?: string;
  effacable?: boolean;
}

const NOMS_JOURS = ["Lu", "Ma", "Me", "Je", "Ve", "Sa", "Di"];
const NOMS_MOIS = [
  "Janvier",
  "Février",
  "Mars",
  "Avril",
  "Mai",
  "Juin",
  "Juillet",
  "Août",
  "Septembre",
  "Octobre",
  "Novembre",
  "Décembre",
];

function formatDateCourte(dateISO: string): string {
  const date = parseDateISO(dateISO);
  const jour = String(date.getDate()).padStart(2, "0");
  const mois = String(date.getMonth() + 1).padStart(2, "0");
  return `${jour}/${mois}/${date.getFullYear()}`;
}

function premierJourDeGrille(moisAffiche: Date): Date {
  const premierDuMois = new Date(moisAffiche.getFullYear(), moisAffiche.getMonth(), 1);
  const decalage = (premierDuMois.getDay() + 6) % 7; // 0 = lundi
  const debut = new Date(premierDuMois);
  debut.setDate(debut.getDate() - decalage);
  return debut;
}

export default function DateField({ id, value, onChange, className, effacable = true }: DateFieldProps) {
  const [ouvert, setOuvert] = useState(false);
  const [moisAffiche, setMoisAffiche] = useState<Date>(() =>
    estDateValide(value) ? parseDateISO(value) : new Date()
  );
  const conteneurRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!ouvert) return;
    const gererClicExterieur = (e: MouseEvent) => {
      if (conteneurRef.current && !conteneurRef.current.contains(e.target as Node)) {
        setOuvert(false);
      }
    };
    document.addEventListener("mousedown", gererClicExterieur);
    return () => document.removeEventListener("mousedown", gererClicExterieur);
  }, [ouvert]);

  const ouvrir = () => {
    setMoisAffiche(estDateValide(value) ? parseDateISO(value) : new Date());
    setOuvert(true);
  };

  const changerMois = (delta: number) => {
    // Navigation uniquement : ne modifie jamais la date sélectionnée.
    setMoisAffiche((precedent) => new Date(precedent.getFullYear(), precedent.getMonth() + delta, 1));
  };

  const choisirJour = (jour: Date) => {
    onChange(toISODate(jour));
    setOuvert(false);
  };

  const effacer = () => {
    onChange("");
    setOuvert(false);
  };

  const debutGrille = premierJourDeGrille(moisAffiche);
  const joursGrille: Date[] = [];
  for (let i = 0; i < 42; i++) {
    const jour = new Date(debutGrille);
    jour.setDate(jour.getDate() + i);
    joursGrille.push(jour);
  }

  const valeurValide = estDateValide(value) ? value : null;

  return (
    <div className="date-field" ref={conteneurRef}>
      <button
        type="button"
        id={id}
        className={`date-field__bouton ${className ?? ""}`.trim()}
        onClick={ouvrir}
      >
        {valeurValide ? formatDateCourte(valeurValide) : "jj/mm/aaaa"}
      </button>
      {ouvert && (
        <div className="date-field__popover">
          <div className="date-field__entete">
            <button type="button" onClick={() => changerMois(-1)} aria-label="Mois précédent">
              ‹
            </button>
            <span>
              {NOMS_MOIS[moisAffiche.getMonth()]} {moisAffiche.getFullYear()}
            </span>
            <button type="button" onClick={() => changerMois(1)} aria-label="Mois suivant">
              ›
            </button>
          </div>
          <div className="date-field__grille-noms">
            {NOMS_JOURS.map((nom) => (
              <span key={nom}>{nom}</span>
            ))}
          </div>
          <div className="date-field__grille">
            {joursGrille.map((jour) => {
              const iso = toISODate(jour);
              const horsMois = jour.getMonth() !== moisAffiche.getMonth();
              const selectionne = valeurValide === iso;
              const classes = [
                "date-field__jour",
                horsMois ? "date-field__jour--hors-mois" : "",
                selectionne ? "date-field__jour--selectionne" : "",
              ]
                .filter(Boolean)
                .join(" ");
              return (
                <button type="button" key={iso} className={classes} onClick={() => choisirJour(jour)}>
                  {jour.getDate()}
                </button>
              );
            })}
          </div>
          {effacable && valeurValide && (
            <button type="button" className="date-field__effacer" onClick={effacer}>
              Effacer la date
            </button>
          )}
        </div>
      )}
    </div>
  );
}
