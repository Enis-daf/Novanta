"use client";

import { useState } from "react";
import DateField from "./DateField";
import { formatDateCourte } from "@/lib/dates";
import { Cible, DIMENSION_GLOBALE, historiqueDesCibles, TypeCible, valeurCibleValide } from "@/lib/pastTargets";

interface PasseCiblesProps {
  cibles: Cible[];
  // Catégories actuellement rattachées à l'étage CA : c'est par elles que se définissent les
  // cibles de marge. Une nouvelle catégorie y apparaît d'elle-même, sans cible.
  categoriesCa: { id: string; nom: string }[];
  // Date d'effet proposée pour une nouvelle cible : le début de la période affichée, pour qu'une
  // cible posée en regardant une période s'y applique. Modifiable.
  dateParDefaut: string;
  onEnregistrer: (type: TypeCible, dimension: string, validFrom: string, valeur: number) => void;
  onSupprimer: (cible: Cible) => void;
}

const formatValeur = new Intl.NumberFormat("fr-FR", { maximumFractionDigits: 2 });
const nombre = (saisie: string) => Number(saisie.replace(/\s/g, "").replace(",", "."));

/** Valeurs datées d'une cible, de la plus ancienne à la plus récente : l'historique reste lisible. */
function Historique({ cibles, unite, onSupprimer }: { cibles: Cible[]; unite: string; onSupprimer: PasseCiblesProps["onSupprimer"] }) {
  if (cibles.length === 0) return <span className="passe-cibles__vide">Cible non définie</span>;
  return (
    <ul className="passe-cibles__historique">
      {cibles.map((cible) => (
        <li key={cible.id}>
          <strong>
            {formatValeur.format(cible.valeur)} {unite}
          </strong>{" "}
          depuis le {formatDateCourte(cible.validFrom)}
          <span className="passe-flux-actions">
            <button
              type="button"
              className="passe-renommer"
              aria-label={`Supprimer la cible du ${formatDateCourte(cible.validFrom)}`}
              data-infobulle="Supprimer"
              onClick={() => onSupprimer(cible)}
            >
              <span aria-hidden="true">×</span>
            </button>
          </span>
        </li>
      ))}
    </ul>
  );
}

/** Une catégorie de CA : sa Marge brute cible, sa Marge contributive cible, et leur date d'effet. */
function LigneCategorie({
  categorie,
  cibles,
  dateParDefaut,
  onEnregistrer,
  onSupprimer,
}: {
  categorie: { id: string; nom: string };
  cibles: Cible[];
  dateParDefaut: string;
  onEnregistrer: PasseCiblesProps["onEnregistrer"];
  onSupprimer: PasseCiblesProps["onSupprimer"];
}) {
  const [margeBrute, setMargeBrute] = useState("");
  const [margeContributive, setMargeContributive] = useState("");
  const [dateEffet, setDateEffet] = useState(dateParDefaut);
  const saisies: [TypeCible, string][] = [
    ["gross_margin_pct", margeBrute],
    ["contribution_margin_pct", margeContributive],
  ];
  const renseignees = saisies.filter(([, saisie]) => saisie.trim() !== "");
  const valide = dateEffet !== "" && renseignees.length > 0 && renseignees.every(([type, saisie]) => valeurCibleValide(type, nombre(saisie)));
  const enregistrer = () => {
    if (!valide) return;
    for (const [type, saisie] of renseignees) onEnregistrer(type, categorie.id, dateEffet, nombre(saisie));
    setMargeBrute("");
    setMargeContributive("");
  };
  const champ = (libelle: string, valeur: string, changer: (v: string) => void) => (
    <span className="passe-cibles__champ">
      <input
        type="text"
        inputMode="decimal"
        aria-label={`${libelle} de la catégorie ${categorie.nom}`}
        placeholder="—"
        value={valeur}
        onChange={(e) => changer(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") enregistrer();
        }}
      />
      %
    </span>
  );

  return (
    <tr>
      <td className="passe-table__libelle">{categorie.nom}</td>
      <td>
        {champ("Marge brute cible", margeBrute, setMargeBrute)}
        <Historique cibles={historiqueDesCibles(cibles, "gross_margin_pct", categorie.id)} unite="%" onSupprimer={onSupprimer} />
      </td>
      <td>
        {champ("Marge contributive cible", margeContributive, setMargeContributive)}
        <Historique cibles={historiqueDesCibles(cibles, "contribution_margin_pct", categorie.id)} unite="%" onSupprimer={onSupprimer} />
      </td>
      <td>
        <DateField value={dateEffet} onChange={setDateEffet} effacable={false} />
      </td>
      <td className="passe-signes-detail__action">
        <button type="button" className="btn-secondaire" disabled={!valide} onClick={enregistrer}>
          Enregistrer
        </button>
      </td>
    </tr>
  );
}

/** Coûts de structure : une cible globale, en euros par mois, datée. */
function CoutsDeStructure({ cibles, dateParDefaut, onEnregistrer, onSupprimer }: Omit<PasseCiblesProps, "categoriesCa">) {
  const [saisie, setSaisie] = useState("");
  const [dateEffet, setDateEffet] = useState(dateParDefaut);
  const valide = saisie.trim() !== "" && dateEffet !== "" && valeurCibleValide("structure_cost_monthly", nombre(saisie));

  return (
    <div className="passe-cibles__ligne">
      <form
        className="passe-cibles__saisie"
        onSubmit={(e) => {
          e.preventDefault();
          if (!valide) return;
          onEnregistrer("structure_cost_monthly", DIMENSION_GLOBALE, dateEffet, nombre(saisie));
          setSaisie("");
        }}
      >
        <label className="passe-controle__label" htmlFor="passe-cible-structure">
          Coûts de structure cibles
        </label>
        <input id="passe-cible-structure" type="text" inputMode="decimal" placeholder="85 000" value={saisie} onChange={(e) => setSaisie(e.target.value)} />
        <span className="passe-cibles__unite">€ / mois</span>
        <span className="passe-controle__label">à partir du</span>
        <DateField value={dateEffet} onChange={setDateEffet} effacable={false} />
        <button type="submit" className="btn-secondaire" disabled={!valide}>
          Enregistrer
        </button>
      </form>
      <Historique cibles={historiqueDesCibles(cibles, "structure_cost_monthly")} unite="€ / mois" onSupprimer={onSupprimer} />
    </div>
  );
}

// Cibles de performance : des références datées, pas un budget. Zone légère de l'onglet
// Correspondance P&L ; la comparaison au réalisé se lit dans Général et les écrans de détail.
// Les cibles de marge se posent par catégorie de CA : la cible globale n'est jamais saisie, elle se
// calcule en pondérant ces cibles par le CA réellement réalisé (lib/pastTargets.ts).
export default function PasseCibles({ cibles, categoriesCa, dateParDefaut, onEnregistrer, onSupprimer }: PasseCiblesProps) {
  return (
    <section className="passe-cibles" id="passe-cibles" aria-label="Cibles de performance">
      <h3 className="eyebrow eyebrow--encre">Cibles</h3>
      <p className="passe-message">
        Une cible s&apos;applique à partir de sa date d&apos;effet : en changer ne modifie pas la lecture des périodes
        antérieures.
      </p>

      <h4 className="passe-fusion__titre">Marges cibles par catégorie de CA</h4>
      <p className="passe-message">
        La cible globale de marge n&apos;est pas saisie : elle est calculée en pondérant ces cibles par le CA réellement
        réalisé dans chaque catégorie sur la période.
      </p>
      {categoriesCa.length === 0 ? (
        <p className="passe-cibles__vide">Aucune catégorie n&apos;est rattachée à l&apos;étage CA pour le moment.</p>
      ) : (
        <div className="table-wrapper">
          <table className="passe-table passe-cibles__table">
            <thead>
              <tr>
                <th>Catégorie de CA</th>
                <th>Marge brute cible</th>
                <th>Marge contributive cible</th>
                <th>Date d&apos;effet</th>
                <th>
                  <span className="passe-visuellement-cache">Action</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {categoriesCa.map((categorie) => (
                <LigneCategorie
                  key={categorie.id}
                  categorie={categorie}
                  cibles={cibles}
                  dateParDefaut={dateParDefaut}
                  onEnregistrer={onEnregistrer}
                  onSupprimer={onSupprimer}
                />
              ))}
            </tbody>
          </table>
        </div>
      )}

      <h4 className="passe-fusion__titre">Coûts de structure</h4>
      <CoutsDeStructure cibles={cibles} dateParDefaut={dateParDefaut} onEnregistrer={onEnregistrer} onSupprimer={onSupprimer} />
    </section>
  );
}
