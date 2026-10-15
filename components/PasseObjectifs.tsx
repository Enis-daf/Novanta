"use client";

import { Fragment, useState } from "react";
import DateField from "./DateField";
import { formatDateCourte } from "@/lib/dates";
import {
  Cible,
  cibleEnConflit,
  DIMENSION_GLOBALE,
  historiqueDesCibles,
  LONGUEUR_MAX_COMMENTAIRE,
  TypeCible,
  UNITE_COUTS_DE_STRUCTURE,
  valeurCibleValide,
} from "@/lib/pastTargets";

type Correction = { valeur: number; validFrom: string };

interface PasseObjectifsProps {
  cibles: Cible[];
  // Catégories actuellement rattachées à l'étage CA : c'est par elles que se définissent les
  // objectifs de marge. Une nouvelle catégorie y apparaît d'elle-même, sans objectif.
  categoriesCa: { id: string; nom: string }[];
  // Date d'effet proposée pour une NOUVELLE cible : le début de la période affichée. Modifiable.
  dateParDefaut: string;
  // Échec du dernier enregistrement, affiché en tête d'écran.
  erreur: string | null;
  // Pose une cible à une date d'effet : mise à jour si elle existe déjà à cette date, nouvelle
  // version sinon — l'appelant décide (lib/pastTargets.ts::poserCible).
  onPoser: (type: TypeCible, dimension: string, validFrom: string, valeur: number) => void;
  // Corrige LA cible désignée (valeur, date d'effet), sans conflit de date.
  onCorriger: (cible: Cible, correction: Correction) => void;
  // Idem, quand la date demandée est déjà celle d'une autre cible et que l'utilisateur a confirmé.
  onRemplacer: (cible: Cible, correction: Correction) => void;
  // Commentaire libre de CETTE version de l'objectif ; vide = pas de commentaire.
  onCommenter: (cible: Cible, saisie: string) => void;
  onSupprimer: (cible: Cible) => void;
}

type Actions = Pick<PasseObjectifsProps, "onCorriger" | "onRemplacer" | "onCommenter" | "onSupprimer">;

/**
 * Commentaire d'une version d'objectif : la note de l'utilisateur sur l'hypothèse derrière le
 * chiffre. Replié par défaut sur une seule ligne (coupée par « … » si elle est longue) ; au clic,
 * une zone de saisie préremplie. Enregistrer n'écrit que le commentaire ; Annuler ne touche à rien.
 */
function CommentaireCible({ cible, onCommenter }: { cible: Cible; onCommenter: PasseObjectifsProps["onCommenter"] }) {
  const [saisie, setSaisie] = useState<string | null>(null);
  const commentaire = cible.commentaire ?? null;
  // Tant que l'ajout de la cible n'est pas confirmé par la base, il n'y a pas de ligne à commenter.
  const enCoursDEnregistrement = cible.id.startsWith("provisoire:");

  if (saisie === null) {
    return (
      <button
        type="button"
        className="passe-cibles__commentaire"
        aria-expanded={false}
        disabled={enCoursDEnregistrement}
        title={commentaire ?? undefined}
        onClick={() => setSaisie(commentaire ?? "")}
      >
        {commentaire === null ? (
          "+ Ajouter un commentaire"
        ) : (
          <>
            <span className="passe-cibles__commentaire-texte">Commentaire : {commentaire.replace(/\s+/g, " ")}</span>
            <span aria-hidden="true">›</span>
          </>
        )}
      </button>
    );
  }

  return (
    <form
      className="passe-cibles__commentaire-saisie"
      onSubmit={(e) => {
        e.preventDefault();
        onCommenter(cible, saisie);
        setSaisie(null);
      }}
    >
      <textarea
        aria-label="Commentaire de l'objectif"
        aria-expanded
        rows={4}
        maxLength={LONGUEUR_MAX_COMMENTAIRE}
        placeholder="Hypothèse derrière cet objectif…"
        value={saisie}
        autoFocus
        onChange={(e) => setSaisie(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Escape") setSaisie(null);
        }}
      />
      <div className="passe-tri">
        <button type="submit" className="btn-secondaire btn-module--actif">
          Enregistrer
        </button>
        <button type="button" className="btn-secondaire" onClick={() => setSaisie(null)}>
          Annuler
        </button>
      </div>
    </form>
  );
}

const formatValeur = new Intl.NumberFormat("fr-FR", { maximumFractionDigits: 2 });
const nombre = (saisie: string) => Number(saisie.replace(/\s/g, "").replace(",", "."));
// Valeur d'une cible telle qu'on la retape : « 44,5 », sans espace de milliers.
const enSaisie = (valeur: number) => String(valeur).replace(".", ",");
const libelleValeur = (cible: Cible, unite: string) => `${formatValeur.format(cible.valeur)} ${unite}`;

/**
 * Une cible existante : lue, ou corrigée sur place. L'édition porte sur CETTE ligne (son
 * identifiant est conservé du clic à l'enregistrement) : valeur et date d'effet préremplies.
 * Même date : la valeur est simplement mise à jour. Date déplacée sur celle d'une autre cible :
 * une confirmation est demandée avant de remplacer quoi que ce soit.
 */
function CibleExistante({ cible, toutes, unite, onCorriger, onRemplacer, onCommenter, onSupprimer }: { cible: Cible; toutes: Cible[]; unite: string } & Actions) {
  const [edition, setEdition] = useState<{ saisie: string; dateEffet: string; aConfirmer: boolean } | null>(null);
  // Tant que l'ajout n'est pas confirmé par la base, la ligne n'a pas encore d'identifiant à corriger.
  const enCoursDEnregistrement = cible.id.startsWith("provisoire:");
  const libelle = libelleValeur(cible, unite);

  if (edition) {
    const valeur = nombre(edition.saisie);
    const valide = edition.saisie.trim() !== "" && edition.dateEffet !== "" && valeurCibleValide(cible.type, valeur);
    const correction = { valeur, validFrom: edition.dateEffet };
    return (
      <form
        className="passe-cibles__edition"
        onSubmit={(e) => {
          e.preventDefault();
          if (!valide) return;
          if (cibleEnConflit(toutes, cible.type, cible.dimension, edition.dateEffet, cible.id)) {
            setEdition({ ...edition, aConfirmer: true });
            return;
          }
          onCorriger(cible, correction);
          setEdition(null);
        }}
      >
        {edition.aConfirmer ? (
          <>
            <span role="alert">
              Une cible existe déjà au {formatDateCourte(edition.dateEffet)}. Voulez-vous remplacer sa valeur par celle-ci ?
            </span>
            <button
              type="button"
              className="btn-secondaire btn-module--actif"
              onClick={() => {
                onRemplacer(cible, correction);
                setEdition(null);
              }}
            >
              Remplacer
            </button>
            <button type="button" className="btn-secondaire" onClick={() => setEdition({ ...edition, aConfirmer: false })}>
              Annuler
            </button>
          </>
        ) : (
          <>
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
          </>
        )}
      </form>
    );
  }

  return (
    <div className="passe-cibles__cible">
    <span className="passe-cibles__valeur">
      <strong>{libelle}</strong>
      <span className="passe-cibles__date">depuis le {formatDateCourte(cible.validFrom)}</span>
      <span className="passe-flux-actions">
        <button
          type="button"
          className="passe-renommer"
          aria-label={`Modifier la cible ${libelle} du ${formatDateCourte(cible.validFrom)}`}
          data-infobulle="Modifier"
          disabled={enCoursDEnregistrement}
          onClick={() => setEdition({ saisie: enSaisie(cible.valeur), dateEffet: cible.validFrom, aConfirmer: false })}
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
    </span>
    {/* Le commentaire appartient à cette version : chaque ligne de l'historique a le sien. */}
    <CommentaireCible cible={cible} onCommenter={onCommenter} />
    </div>
  );
}

/** Objectif d'un type : sa version la plus récente, ou « Non défini ». Les versions antérieures se voient dans l'historique. */
function ObjectifCourant({ historique, toutes, unite, ...actions }: { historique: Cible[]; toutes: Cible[]; unite: string } & Actions) {
  const courante = historique[historique.length - 1];
  return courante ? <CibleExistante key={courante.id} cible={courante} toutes={toutes} unite={unite} {...actions} /> : <span className="passe-cibles__vide">Non défini</span>;
}

/** Versions antérieures d'un objectif, de la plus ancienne à la plus récente — chacune corrigeable. */
function VersionsAnterieures({ titre, historique, toutes, unite, ...actions }: { titre: string; historique: Cible[]; toutes: Cible[]; unite: string } & Actions) {
  const anterieures = historique.slice(0, -1);
  if (anterieures.length === 0) return null;
  return (
    <div className="passe-cibles__versions">
      <span className="passe-controle__label">{titre}</span>
      {anterieures.map((cible) => (
        <CibleExistante key={cible.id} cible={cible} toutes={toutes} unite={unite} {...actions} />
      ))}
    </div>
  );
}

/** Une catégorie de CA : ses deux objectifs de marge, et de quoi en poser une nouvelle version. */
function LigneCategorie({
  categorie,
  cibles,
  dateParDefaut,
  onPoser,
  ...actions
}: { categorie: { id: string; nom: string }; cibles: Cible[]; dateParDefaut: string; onPoser: PasseObjectifsProps["onPoser"] } & Actions) {
  const [nouvelle, setNouvelle] = useState<{ margeBrute: string; margeContributive: string; dateEffet: string } | null>(null);
  const [historiqueOuvert, setHistoriqueOuvert] = useState(false);
  const brute = historiqueDesCibles(cibles, "gross_margin_pct", categorie.id);
  const contributive = historiqueDesCibles(cibles, "contribution_margin_pct", categorie.id);
  const definie = brute.length + contributive.length > 0;
  const versionsAnterieures = Math.max(0, brute.length - 1) + Math.max(0, contributive.length - 1);

  const saisies: [TypeCible, string][] = nouvelle
    ? [
        ["gross_margin_pct", nouvelle.margeBrute],
        ["contribution_margin_pct", nouvelle.margeContributive],
      ]
    : [];
  const renseignees = saisies.filter(([, saisie]) => saisie.trim() !== "");
  const valide = nouvelle !== null && nouvelle.dateEffet !== "" && renseignees.length > 0 && renseignees.every(([type, saisie]) => valeurCibleValide(type, nombre(saisie)));

  return (
    <Fragment>
      <tr>
        <td className="passe-table__libelle">{categorie.nom}</td>
        <td>
          <ObjectifCourant historique={brute} toutes={cibles} unite="%" {...actions} />
        </td>
        <td>
          <ObjectifCourant historique={contributive} toutes={cibles} unite="%" {...actions} />
        </td>
        <td className="passe-signes-detail__action">
          <button type="button" className="btn-secondaire" aria-expanded={nouvelle !== null} onClick={() => setNouvelle(nouvelle ? null : { margeBrute: "", margeContributive: "", dateEffet: dateParDefaut })}>
            {definie ? "Nouvelle cible" : "Définir"}
          </button>
          {versionsAnterieures > 0 && (
            <button type="button" className="passe-lien-ligne passe-cibles__lien" aria-expanded={historiqueOuvert} onClick={() => setHistoriqueOuvert((o) => !o)}>
              {historiqueOuvert ? "Masquer l'historique" : `Voir l'historique (${versionsAnterieures})`}
            </button>
          )}
        </td>
      </tr>
      {nouvelle && (
        <tr className="passe-cibles__sous-ligne">
          <td colSpan={4}>
            {/* Nouvelle version datée. Posée à une date d'effet déjà utilisée, elle met simplement
                à jour la cible de cette date : pas d'erreur, pas de doublon. */}
            <form
              className="passe-cibles__edition"
              onSubmit={(e) => {
                e.preventDefault();
                if (!valide) return;
                for (const [type, saisie] of renseignees) onPoser(type, categorie.id, nouvelle.dateEffet, nombre(saisie));
                setNouvelle(null);
              }}
            >
              <label>
                Marge brute{" "}
                <input type="text" inputMode="decimal" autoFocus placeholder="—" value={nouvelle.margeBrute} onChange={(e) => setNouvelle({ ...nouvelle, margeBrute: e.target.value })} /> %
              </label>
              <label>
                Marge contributive{" "}
                <input type="text" inputMode="decimal" placeholder="—" value={nouvelle.margeContributive} onChange={(e) => setNouvelle({ ...nouvelle, margeContributive: e.target.value })} /> %
              </label>
              <span>à partir du</span>
              <DateField value={nouvelle.dateEffet} onChange={(dateEffet) => setNouvelle({ ...nouvelle, dateEffet })} effacable={false} />
              <button type="submit" className="btn-secondaire btn-module--actif" disabled={!valide}>
                Enregistrer
              </button>
              <button type="button" className="btn-secondaire" onClick={() => setNouvelle(null)}>
                Annuler
              </button>
            </form>
          </td>
        </tr>
      )}
      {historiqueOuvert && versionsAnterieures > 0 && (
        <tr className="passe-cibles__sous-ligne">
          <td colSpan={4}>
            <VersionsAnterieures titre="Marge brute, versions antérieures" historique={brute} toutes={cibles} unite="%" {...actions} />
            <VersionsAnterieures titre="Marge contributive, versions antérieures" historique={contributive} toutes={cibles} unite="%" {...actions} />
          </td>
        </tr>
      )}
    </Fragment>
  );
}

/** Coûts de structure : un objectif global, en euros HT par mois, daté. */
function CoutsDeStructure({ cibles, dateParDefaut, onPoser, ...actions }: Pick<PasseObjectifsProps, "cibles" | "dateParDefaut" | "onPoser"> & Actions) {
  const [nouvelle, setNouvelle] = useState<{ saisie: string; dateEffet: string } | null>(null);
  const [historiqueOuvert, setHistoriqueOuvert] = useState(false);
  const historique = historiqueDesCibles(cibles, "structure_cost_monthly");
  const valide = nouvelle !== null && nouvelle.saisie.trim() !== "" && nouvelle.dateEffet !== "" && valeurCibleValide("structure_cost_monthly", nombre(nouvelle.saisie));

  return (
    <div className="passe-cibles__ligne">
      <div className="passe-cibles__saisie">
        <span className="passe-controle__label">Montant mensuel cible</span>
        <ObjectifCourant historique={historique} toutes={cibles} unite={UNITE_COUTS_DE_STRUCTURE} {...actions} />
        <button type="button" className="btn-secondaire" aria-expanded={nouvelle !== null} onClick={() => setNouvelle(nouvelle ? null : { saisie: "", dateEffet: dateParDefaut })}>
          {historique.length > 0 ? "Nouvelle cible" : "Définir"}
        </button>
        {historique.length > 1 && (
          <button type="button" className="passe-lien-ligne passe-cibles__lien" aria-expanded={historiqueOuvert} onClick={() => setHistoriqueOuvert((o) => !o)}>
            {historiqueOuvert ? "Masquer l'historique" : `Voir l'historique (${historique.length - 1})`}
          </button>
        )}
      </div>
      {nouvelle && (
        <form
          className="passe-cibles__edition"
          onSubmit={(e) => {
            e.preventDefault();
            if (!valide) return;
            onPoser("structure_cost_monthly", DIMENSION_GLOBALE, nouvelle.dateEffet, nombre(nouvelle.saisie));
            setNouvelle(null);
          }}
        >
          <input
            type="text"
            inputMode="decimal"
            aria-label="Nouveau montant mensuel cible des coûts de structure"
            autoFocus
            placeholder="85 000"
            value={nouvelle.saisie}
            onChange={(e) => setNouvelle({ ...nouvelle, saisie: e.target.value })}
          />
          <span>{UNITE_COUTS_DE_STRUCTURE} à partir du</span>
          <DateField value={nouvelle.dateEffet} onChange={(dateEffet) => setNouvelle({ ...nouvelle, dateEffet })} effacable={false} />
          <button type="submit" className="btn-secondaire btn-module--actif" disabled={!valide}>
            Enregistrer
          </button>
          <button type="button" className="btn-secondaire" onClick={() => setNouvelle(null)}>
            Annuler
          </button>
        </form>
      )}
      {historiqueOuvert && <VersionsAnterieures titre="Versions antérieures" historique={historique} toutes={cibles} unite={UNITE_COUTS_DE_STRUCTURE} {...actions} />}
    </div>
  );
}

// Onglet « Objectifs » : les trois références de performance du module, et rien d'autre. Des
// objectifs datés, pas un budget ; la comparaison au réalisé se lit dans Général et les écrans de
// détail. Les objectifs de marge se posent par catégorie de CA : la cible globale n'est jamais
// saisie, elle se calcule en pondérant par le CA réellement réalisé (lib/pastTargets.ts).
// Le crayon corrige une cible existante ; « Nouvelle cible » en pose une à partir d'une autre date.
export default function PasseObjectifs({ cibles, categoriesCa, dateParDefaut, erreur, onPoser, onCorriger, onRemplacer, onCommenter, onSupprimer }: PasseObjectifsProps) {
  const actions = { onCorriger, onRemplacer, onCommenter, onSupprimer };
  return (
    <div className="passe-cibles">
      {erreur && (
        <p className="login-erreur" role="alert">
          {erreur}
        </p>
      )}

      <section className="passe-cibles__section">
        <h3 className="eyebrow eyebrow--encre">Objectifs de marge par catégorie d&apos;encaissements</h3>
        <p className="passe-message">
          L&apos;objectif global de marge n&apos;est pas saisi : il est calculé en pondérant ces cibles par les
          encaissements HT estimés de chaque catégorie sur la période. Une cible s&apos;applique à partir de sa date d&apos;effet.
        </p>
        {categoriesCa.length === 0 ? (
          <p className="passe-cibles__vide">Aucune catégorie n&apos;est rattachée à l&apos;étage Encaissements pour le moment.</p>
        ) : (
          <div className="table-wrapper">
            <table className="passe-table passe-cibles__table">
              <thead>
                <tr>
                  <th>Catégorie d&apos;encaissements</th>
                  <th>Marge brute cible</th>
                  <th>Marge contributive cible</th>
                  <th>
                    <span className="passe-visuellement-cache">Action</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {categoriesCa.map((categorie) => (
                  <LigneCategorie key={categorie.id} categorie={categorie} cibles={cibles} dateParDefaut={dateParDefaut} onPoser={onPoser} {...actions} />
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section className="passe-cibles__section">
        <h3 className="eyebrow eyebrow--encre">Coûts de structure</h3>
        <p className="passe-message">Montants mensuels saisis en HT.</p>
        <CoutsDeStructure cibles={cibles} dateParDefaut={dateParDefaut} onPoser={onPoser} {...actions} />
      </section>
    </div>
  );
}
