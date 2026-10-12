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
  // Date d'effet proposée pour une NOUVELLE cible : le début de la période affichée, pour qu'une
  // cible posée en regardant une période s'y applique. Modifiable.
  dateParDefaut: string;
  // Échec du dernier enregistrement (conflit de date d'effet, refus…), affiché dans la zone.
  erreur: string | null;
  // Nouvelle version datée : une ligne de plus dans l'historique.
  onAjouter: (type: TypeCible, dimension: string, validFrom: string, valeur: number) => void;
  // Correction d'une cible existante : la même ligne. false = refusée, la saisie reste ouverte.
  onCorriger: (cible: Cible, correction: { valeur: number; validFrom: string }) => boolean;
  onSupprimer: (cible: Cible) => void;
}

type Actions = Pick<PasseCiblesProps, "onCorriger" | "onSupprimer">;

const formatValeur = new Intl.NumberFormat("fr-FR", { maximumFractionDigits: 2 });
const nombre = (saisie: string) => Number(saisie.replace(/\s/g, "").replace(",", "."));
// Valeur d'une cible telle qu'on la retape : « 44,5 », sans espace de milliers.
const enSaisie = (valeur: number) => String(valeur).replace(".", ",");

/**
 * Une cible existante : lue, ou corrigée sur place — valeur et date d'effet préremplies. Corriger
 * modifie CETTE ligne ; pour faire évoluer la cible à partir d'une autre date, on en ajoute une.
 */
function CibleExistante({ cible, unite, onCorriger, onSupprimer }: { cible: Cible; unite: string } & Actions) {
  const [edition, setEdition] = useState<{ saisie: string; dateEffet: string } | null>(null);
  // Tant que l'ajout n'est pas confirmé par la base, la ligne n'a pas encore d'identifiant à corriger.
  const enCoursDEnregistrement = cible.id.startsWith("provisoire:");
  const libelle = `${formatValeur.format(cible.valeur)} ${unite}`;

  if (edition) {
    const valeur = nombre(edition.saisie);
    const valide = edition.saisie.trim() !== "" && edition.dateEffet !== "" && valeurCibleValide(cible.type, valeur);
    const inchangee = valeur === cible.valeur && edition.dateEffet === cible.validFrom;
    return (
      <li>
        <form
          className="passe-cibles__edition"
          onSubmit={(e) => {
            e.preventDefault();
            if (!valide) return;
            if (inchangee || onCorriger(cible, { valeur, validFrom: edition.dateEffet })) setEdition(null);
          }}
        >
          <input
            type="text"
            inputMode="decimal"
            aria-label={`Valeur de la cible du ${formatDateCourte(cible.validFrom)}`}
            value={edition.saisie}
            autoFocus
            onChange={(e) => setEdition({ ...edition, saisie: e.target.value })}
            onKeyDown={(e) => {
              if (e.key === "Escape") setEdition(null);
            }}
          />
          <span>{unite} depuis le</span>
          <DateField value={edition.dateEffet} onChange={(dateEffet) => setEdition({ ...edition, dateEffet })} effacable={false} />
          <button type="submit" className="btn-secondaire btn-module--actif" disabled={!valide}>
            Enregistrer
          </button>
          <button type="button" className="btn-secondaire" onClick={() => setEdition(null)}>
            Annuler
          </button>
        </form>
      </li>
    );
  }

  return (
    <li>
      <strong>{libelle}</strong> depuis le {formatDateCourte(cible.validFrom)}
      <span className="passe-flux-actions">
        <button
          type="button"
          className="passe-renommer"
          aria-label={`Modifier la cible ${libelle} du ${formatDateCourte(cible.validFrom)}`}
          data-infobulle="Modifier"
          disabled={enCoursDEnregistrement}
          onClick={() => setEdition({ saisie: enSaisie(cible.valeur), dateEffet: cible.validFrom })}
        >
          <span aria-hidden="true">✎</span>
        </button>
        <button
          type="button"
          className="passe-renommer"
          aria-label={`Supprimer la cible ${libelle} du ${formatDateCourte(cible.validFrom)}`}
          data-infobulle="Supprimer"
          disabled={enCoursDEnregistrement}
          onClick={() => onSupprimer(cible)}
        >
          <span aria-hidden="true">×</span>
        </button>
      </span>
    </li>
  );
}

/** Valeurs datées d'une cible, de la plus ancienne à la plus récente : l'historique reste lisible. */
function Historique({ cibles, unite, ...actions }: { cibles: Cible[]; unite: string } & Actions) {
  if (cibles.length === 0) return <span className="passe-cibles__vide">Cible non définie</span>;
  return (
    <ul className="passe-cibles__historique">
      {cibles.map((cible) => (
        <CibleExistante key={cible.id} cible={cible} unite={unite} {...actions} />
      ))}
    </ul>
  );
}

/** Une catégorie de CA : ses cibles de marge existantes, et de quoi en ajouter une nouvelle version. */
function LigneCategorie({
  categorie,
  cibles,
  dateParDefaut,
  onAjouter,
  ...actions
}: { categorie: { id: string; nom: string }; cibles: Cible[]; dateParDefaut: string; onAjouter: PasseCiblesProps["onAjouter"] } & Actions) {
  const [margeBrute, setMargeBrute] = useState("");
  const [margeContributive, setMargeContributive] = useState("");
  const [dateEffet, setDateEffet] = useState(dateParDefaut);
  const saisies: [TypeCible, string][] = [
    ["gross_margin_pct", margeBrute],
    ["contribution_margin_pct", margeContributive],
  ];
  const renseignees = saisies.filter(([, saisie]) => saisie.trim() !== "");
  const valide = dateEffet !== "" && renseignees.length > 0 && renseignees.every(([type, saisie]) => valeurCibleValide(type, nombre(saisie)));
  const ajouter = () => {
    if (!valide) return;
    for (const [type, saisie] of renseignees) onAjouter(type, categorie.id, dateEffet, nombre(saisie));
    setMargeBrute("");
    setMargeContributive("");
  };
  const champ = (libelle: string, valeur: string, changer: (v: string) => void) => (
    <span className="passe-cibles__champ">
      <input
        type="text"
        inputMode="decimal"
        aria-label={`Nouvelle ${libelle} de la catégorie ${categorie.nom}`}
        placeholder="Nouvelle"
        value={valeur}
        onChange={(e) => changer(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") ajouter();
        }}
      />
      %
    </span>
  );

  return (
    <tr>
      <td className="passe-table__libelle">{categorie.nom}</td>
      <td>
        <Historique cibles={historiqueDesCibles(cibles, "gross_margin_pct", categorie.id)} unite="%" {...actions} />
        {champ("marge brute cible", margeBrute, setMargeBrute)}
      </td>
      <td>
        <Historique cibles={historiqueDesCibles(cibles, "contribution_margin_pct", categorie.id)} unite="%" {...actions} />
        {champ("marge contributive cible", margeContributive, setMargeContributive)}
      </td>
      <td>
        <DateField value={dateEffet} onChange={setDateEffet} effacable={false} />
      </td>
      <td className="passe-signes-detail__action">
        <button type="button" className="btn-secondaire" disabled={!valide} onClick={ajouter}>
          Ajouter
        </button>
      </td>
    </tr>
  );
}

/** Coûts de structure : une cible globale, en euros par mois, datée. */
function CoutsDeStructure({ cibles, dateParDefaut, onAjouter, ...actions }: Pick<PasseCiblesProps, "cibles" | "dateParDefaut" | "onAjouter"> & Actions) {
  const [saisie, setSaisie] = useState("");
  const [dateEffet, setDateEffet] = useState(dateParDefaut);
  const valide = saisie.trim() !== "" && dateEffet !== "" && valeurCibleValide("structure_cost_monthly", nombre(saisie));

  return (
    <div className="passe-cibles__ligne">
      <Historique cibles={historiqueDesCibles(cibles, "structure_cost_monthly")} unite="€ / mois" {...actions} />
      <form
        className="passe-cibles__saisie"
        onSubmit={(e) => {
          e.preventDefault();
          if (!valide) return;
          onAjouter("structure_cost_monthly", DIMENSION_GLOBALE, dateEffet, nombre(saisie));
          setSaisie("");
        }}
      >
        <label className="passe-controle__label" htmlFor="passe-cible-structure">
          Nouvelle cible
        </label>
        <input id="passe-cible-structure" type="text" inputMode="decimal" placeholder="85 000" value={saisie} onChange={(e) => setSaisie(e.target.value)} />
        <span className="passe-cibles__unite">€ / mois</span>
        <span className="passe-controle__label">à partir du</span>
        <DateField value={dateEffet} onChange={setDateEffet} effacable={false} />
        <button type="submit" className="btn-secondaire" disabled={!valide}>
          Ajouter
        </button>
      </form>
    </div>
  );
}

// Cibles de performance : des références datées, pas un budget. Zone légère de l'onglet
// Correspondance P&L ; la comparaison au réalisé se lit dans Général et les écrans de détail.
// Les cibles de marge se posent par catégorie de CA : la cible globale n'est jamais saisie, elle se
// calcule en pondérant ces cibles par le CA réellement réalisé (lib/pastTargets.ts).
// Deux gestes : le crayon CORRIGE une cible existante (sa valeur, sa date d'effet) ; « Ajouter »
// crée une nouvelle version à partir d'une autre date d'effet.
export default function PasseCibles({ cibles, categoriesCa, dateParDefaut, erreur, onAjouter, onCorriger, onSupprimer }: PasseCiblesProps) {
  const actions = { onCorriger, onSupprimer };
  return (
    <section className="passe-cibles" id="passe-cibles" aria-label="Cibles de performance">
      <h3 className="eyebrow eyebrow--encre">Cibles</h3>
      <p className="passe-message">
        Une cible s&apos;applique à partir de sa date d&apos;effet. Le crayon corrige une cible existante ; « Ajouter » en
        crée une nouvelle version à partir d&apos;une autre date, sans modifier la lecture des périodes antérieures.
      </p>
      {erreur && (
        <p className="login-erreur" role="alert">
          {erreur}
        </p>
      )}

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
                <th>Nouvelle cible à partir du</th>
                <th>
                  <span className="passe-visuellement-cache">Action</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {categoriesCa.map((categorie) => (
                <LigneCategorie key={categorie.id} categorie={categorie} cibles={cibles} dateParDefaut={dateParDefaut} onAjouter={onAjouter} {...actions} />
              ))}
            </tbody>
          </table>
        </div>
      )}

      <h4 className="passe-fusion__titre">Coûts de structure</h4>
      <CoutsDeStructure cibles={cibles} dateParDefaut={dateParDefaut} onAjouter={onAjouter} {...actions} />
    </section>
  );
}
