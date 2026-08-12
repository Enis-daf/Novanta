"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { formatMontant } from "@/lib/format";
import { normaliserRecherche } from "@/lib/recherche";
import { OptionSourceCalcul, OptionsSourceCalcul } from "@/lib/montantCalcule";
import { TypeSourceCalculChargeFixe } from "@/lib/types";

interface SourceCalculSelectProps {
  options: OptionsSourceCalcul;
  valeur: { type: TypeSourceCalculChargeFixe; id: string } | null;
  onChange: (type: TypeSourceCalculChargeFixe, id: string) => void;
}

function libelleOption(option: OptionSourceCalcul): string {
  return `${option.libelle || "Sans libellé"} — ${formatMontant(option.montant)} — ${option.frequence}`;
}

export default function SourceCalculSelect({ options, valeur, onChange }: SourceCalculSelectProps) {
  const [ouvert, setOuvert] = useState(false);
  const [recherche, setRecherche] = useState("");
  const [position, setPosition] = useState({ top: 0, left: 0, width: 0 });
  const conteneurRef = useRef<HTMLDivElement>(null);
  const popoverRef = useRef<HTMLDivElement>(null);
  const rechercheRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!ouvert) return;
    const gererClicExterieur = (e: MouseEvent) => {
      const cible = e.target as Node;
      if (
        conteneurRef.current &&
        !conteneurRef.current.contains(cible) &&
        popoverRef.current &&
        !popoverRef.current.contains(cible)
      ) {
        setOuvert(false);
      }
    };
    document.addEventListener("mousedown", gererClicExterieur);
    return () => document.removeEventListener("mousedown", gererClicExterieur);
  }, [ouvert]);

  const ouvrir = () => {
    if (conteneurRef.current) {
      const rect = conteneurRef.current.getBoundingClientRect();
      setPosition({ top: rect.bottom + window.scrollY + 4, left: rect.left + window.scrollX, width: Math.max(rect.width, 220) });
    }
    setRecherche("");
    setOuvert(true);
    setTimeout(() => rechercheRef.current?.focus(), 0);
  };

  const choisir = (type: TypeSourceCalculChargeFixe, id: string) => {
    onChange(type, id);
    setOuvert(false);
  };

  const optionSelectionnee = useMemo(() => {
    if (!valeur) return null;
    const liste = valeur.type === "charge_fixe" ? options.chargesFixes : options.rentreesRegulieres;
    return liste.find((o) => o.id === valeur.id) ?? null;
  }, [valeur, options]);

  const chargesFiltrees = useMemo(
    () => options.chargesFixes.filter((o) => normaliserRecherche(libelleOption(o)).includes(normaliserRecherche(recherche))),
    [options.chargesFixes, recherche]
  );
  const rentreesFiltrees = useMemo(
    () =>
      options.rentreesRegulieres.filter((o) =>
        normaliserRecherche(libelleOption(o)).includes(normaliserRecherche(recherche))
      ),
    [options.rentreesRegulieres, recherche]
  );

  return (
    <div className="source-calcul-select" ref={conteneurRef}>
      <button type="button" className="source-calcul-select__bouton" onClick={ouvrir}>
        {optionSelectionnee ? libelleOption(optionSelectionnee) : "Choisir une source"}
      </button>
      {ouvert &&
        createPortal(
          <div
            className="source-calcul-select__popover"
            ref={popoverRef}
            style={{ position: "absolute", top: position.top, left: position.left, minWidth: position.width }}
          >
            <input
              ref={rechercheRef}
              type="text"
              className="source-calcul-select__recherche"
              placeholder="Rechercher une source…"
              value={recherche}
              onChange={(e) => setRecherche(e.target.value)}
            />
            <div className="source-calcul-select__liste">
              {chargesFiltrees.length > 0 && (
                <div className="source-calcul-select__groupe">
                  <p className="source-calcul-select__groupe-titre">Charges fixes</p>
                  {chargesFiltrees.map((option) => (
                    <button
                      type="button"
                      key={option.id}
                      className="source-calcul-select__option"
                      onClick={() => choisir("charge_fixe", option.id)}
                    >
                      {libelleOption(option)}
                    </button>
                  ))}
                </div>
              )}
              {rentreesFiltrees.length > 0 && (
                <div className="source-calcul-select__groupe">
                  <p className="source-calcul-select__groupe-titre">Rentrées régulières</p>
                  {rentreesFiltrees.map((option) => (
                    <button
                      type="button"
                      key={option.id}
                      className="source-calcul-select__option"
                      onClick={() => choisir("rentree_reguliere", option.id)}
                    >
                      {libelleOption(option)}
                    </button>
                  ))}
                </div>
              )}
              {chargesFiltrees.length === 0 && rentreesFiltrees.length === 0 && (
                <p className="source-calcul-select__vide">Aucune source disponible</p>
              )}
            </div>
          </div>,
          document.body
        )}
    </div>
  );
}
