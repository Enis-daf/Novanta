"use client";

import { useEffect, useMemo, useState } from "react";
import PasseSelecteurPeriode from "./PasseSelecteurPeriode";
import PasseWaterfallChart from "./PasseWaterfallChart";
import { supabase } from "@/lib/supabaseClient";
import { formatDateCourte } from "@/lib/dates";
import {
  ConfigExercice,
  dureeDeLaSelection,
  normaliserDurees,
  periodeDeLaSelection,
  PRESETS_AVEC_MOIS,
  SelectionPeriode,
} from "@/lib/fiscalPeriods";
import { dissocierFlux, fusionnerFlux, GroupeManuel, indexerGroupesManuels, nomDeGroupePropose } from "@/lib/flowGroups";
import { buildCanonicalFlowIdentity, FlowAlias, LONGUEUR_MAX_ALIAS, MatchMethod, normaliserNomAlias } from "@/lib/flowMatching";
import { formatMontant, formatPourcentage } from "@/lib/format";
import { AjustementGestion } from "@/lib/pastAdjustments";
import { EtagePnl, MappingCategorie } from "@/lib/pastCategoryMapping";
import { TRI_TRANSACTIONS_PAR_DEFAUT, trierTransactions, TriTransactions } from "@/lib/pastDetail";
import { PastTransactionStockee, Periode, periodeValide } from "@/lib/pastTransactions";
import {
  chargerAliasFlux,
  chargerGroupesFlux,
  chargerPastTransactions,
  enregistrerGroupeFlux,
  renommerGroupeFlux,
  retirerFluxDuGroupe,
  sauvegarderAliasFlux,
  supprimerAliasFlux,
  supprimerGroupeFlux,
} from "@/lib/pastTransactionsRepository";
import {
  categoriesDeLEtage,
  comparerPeriodes,
  donneesPeriode,
  ETAGES_ECARTS,
  fluxConnus,
  GroupeLibelle,
  groupesDeLibelles,
  PartComparee,
  transactionsDuGroupe,
} from "@/lib/pastVariance";

export interface SelectionsEcarts {
  a: SelectionPeriode;
  b: SelectionPeriode;
}

interface PasseEcartsProps {
  organizationId: string;
  axeId: string | null;
  mappings: ReadonlyMap<string, MappingCategorie>;
  // Tous les ajustements de gestion de l'organisation, toutes périodes confondues : chaque période
  // comparée en prend sa part.
  ajustements: AjustementGestion[];
  aujourdhui: string;
  configExercice: ConfigExercice;
  // Les deux périodes comparées appartiennent au module (pas à cet écran) : elles survivent à la
  // navigation entre onglets.
  selections: SelectionsEcarts;
  onChangeSelections: (selections: SelectionsEcarts) => void;
  // Incrémenté après une synchronisation : les deux périodes sont relues.
  rechargement: number;
}

const PAS_AFFICHAGE = 100;
// Au-delà, la recherche du panneau de fusion doit être précisée.
const MAX_PROPOSITIONS_FUSION = 8;
const TRIS: { cle: TriTransactions; libelle: string }[] = [
  { cle: "montant", libelle: "Montant" },
  { cle: "date", libelle: "Date" },
];

const METHODES: Record<MatchMethod, string> = {
  sepa_emitter_mandate: "même émetteur et même mandat SEPA",
  structured_counterparty: "même contrepartie",
  exact_normalized: "même libellé",
  token_similarity: "contreparties voisines",
};

function signe(montant: number): string {
  return montant > 0 ? `+${formatMontant(montant)}` : formatMontant(montant);
}

function libellePeriode(periode: Periode): string {
  return `${formatDateCourte(periode.debut)} → ${formatDateCourte(periode.fin)}`;
}

function Contribution({ montant }: { montant: number }) {
  const classe = montant > 0 ? " passe-ecart--positif" : montant < 0 ? " passe-ecart--negatif" : "";
  return <span className={`passe-ecart${classe}`}>{signe(montant)}</span>;
}

// Onglet Écarts : du Cash flow de la période A à celui de la période B — étage contributif,
// catégorie contributive, puis transactions. Les périodes viennent du moteur du module
// (lib/fiscalPeriods.ts), les calculs de lib/pastVariance.ts ; cet écran n'en porte aucun.
export default function PasseEcarts({
  organizationId,
  axeId,
  mappings,
  ajustements,
  aujourdhui,
  configExercice,
  selections,
  onChangeSelections,
  rechargement,
}: PasseEcartsProps) {
  const bornesA = periodeDeLaSelection(selections.a, aujourdhui, configExercice);
  const bornesB = periodeDeLaSelection(selections.b, aujourdhui, configExercice);
  const periodeA = useMemo<Periode>(() => ({ debut: bornesA.debut, fin: bornesA.fin }), [bornesA.debut, bornesA.fin]);
  const periodeB = useMemo<Periode>(() => ({ debut: bornesB.debut, fin: bornesB.fin }), [bornesB.debut, bornesB.fin]);
  const periodesOk = periodeValide(periodeA) && periodeValide(periodeB);
  // Durées différentes : la période la plus longue est ramenée à la plus courte, pour les agrégats
  // uniquement. Toujours annoncé à l'écran, jamais silencieux.
  const dureeA = dureeDeLaSelection(selections.a, aujourdhui, configExercice);
  const dureeB = dureeDeLaSelection(selections.b, aujourdhui, configExercice);
  const { coefficientA, coefficientB, detail: normalisation } = useMemo(
    () => normaliserDurees(dureeA, dureeB),
    // Dépendances : les quatre nombres, pas les objets (recréés à chaque rendu).
    [dureeA.mois, dureeA.jours, dureeB.mois, dureeB.jours]
  );

  const [transactions, setTransactions] = useState<{ a: PastTransactionStockee[]; b: PastTransactionStockee[] } | null>(null);
  const [erreur, setErreur] = useState<string | null>(null);
  const [tentative, setTentative] = useState(0);

  // Exploration : étage -> catégorie -> groupe de libellés. Propre à cet écran.
  const [etage, setEtage] = useState<EtagePnl | null>(null);
  const [categorie, setCategorie] = useState<string | null>(null);
  const [groupe, setGroupe] = useState<string | null>(null);
  const [voirTout, setVoirTout] = useState(false);
  const [tri, setTri] = useState<TriTransactions>(TRI_TRANSACTIONS_PAR_DEFAUT);
  const [nombreAffiche, setNombreAffiche] = useState(PAS_AFFICHAGE);

  // Noms donnés par l'organisation aux flux reconnus (en base). Ils ne changent que l'affichage.
  const [aliasFlux, setAliasFlux] = useState<FlowAlias[]>([]);
  const [renommage, setRenommage] = useState<{ cle: string; saisie: string } | null>(null);
  const [erreurAlias, setErreurAlias] = useState<string | null>(null);
  const aliasParCle = useMemo(() => new Map(aliasFlux.map((a) => [a.canonicalFlowKey, a.displayName])), [aliasFlux]);
  // Regroupements manuels de l'organisation (en base) : ils réunissent des flux que le moteur
  // laisse séparés, et passent avant lui.
  const [groupesManuels, setGroupesManuels] = useState<GroupeManuel[]>([]);
  const manuels = useMemo(() => indexerGroupesManuels(groupesManuels), [groupesManuels]);
  // Panneau « Fusionner » ouvert sur une ligne : recherche, flux choisi, nom du groupe.
  const [fusion, setFusion] = useState<{
    cle: string;
    recherche: string;
    cible: string | null;
    nom: string;
    // Flux dont la dissociation attend une confirmation (identité propre), sinon null.
    aDissocier: string | null;
  } | null>(null);
  const [versionGroupes, setVersionGroupes] = useState(0);

  useEffect(() => {
    let annule = false;
    // Indisponibles : l'analyse s'affiche quand même, sous les noms détectés.
    chargerAliasFlux(supabase!, organizationId)
      .then((alias) => {
        if (!annule) setAliasFlux(alias);
      })
      .catch((error) => {
        const code = (error as { code?: string } | null)?.code ?? "inconnu";
        console.error(`[passe/alias] step=load organization=${organizationId} code=${code}`);
      });
    return () => {
      annule = true;
    };
  }, [organizationId]);

  useEffect(() => {
    let annule = false;
    // Indisponibles : l'analyse s'affiche quand même, avec les seuls regroupements du moteur.
    chargerGroupesFlux(supabase!, organizationId)
      .then((groupesConnus) => {
        if (!annule) setGroupesManuels(groupesConnus);
      })
      .catch((error) => {
        const code = (error as { code?: string } | null)?.code ?? "inconnu";
        console.error(`[passe/groupes] step=load organization=${organizationId} code=${code}`);
      });
    return () => {
      annule = true;
    };
  }, [organizationId, versionGroupes]);

  useEffect(() => {
    if (!periodesOk) {
      setTransactions(null);
      setErreur(null);
      return;
    }
    let annule = false;
    setTransactions(null);
    setErreur(null);
    Promise.all([
      chargerPastTransactions(supabase!, organizationId, periodeA),
      chargerPastTransactions(supabase!, organizationId, periodeB),
    ])
      .then(([a, b]) => {
        if (!annule) setTransactions({ a, b });
      })
      .catch((error) => {
        if (annule) return;
        console.error("Échec du chargement des périodes comparées :", error);
        setErreur("Impossible de charger les transactions des deux périodes pour le moment.");
      });
    return () => {
      annule = true;
    };
  }, [organizationId, periodeA, periodeB, periodesOk, rechargement, tentative]);

  const donnees = useMemo(
    () =>
      transactions && {
        a: donneesPeriode(transactions.a, axeId, mappings, ajustements, periodeA, coefficientA),
        b: donneesPeriode(transactions.b, axeId, mappings, ajustements, periodeB, coefficientB),
      },
    [transactions, axeId, mappings, ajustements, periodeA, periodeB, coefficientA, coefficientB]
  );
  const comparaison = useMemo(() => donnees && comparerPeriodes(donnees.a, donnees.b), [donnees]);
  const categories = useMemo(() => (donnees && etage ? categoriesDeLEtage(donnees.a, donnees.b, etage) : []), [donnees, etage]);
  const groupes = useMemo(
    () => (donnees && etage ? groupesDeLibelles(donnees.a, donnees.b, etage, categorie, aliasParCle, manuels) : []),
    [donnees, etage, categorie, aliasParCle, manuels]
  );
  // Flux proposés à la fusion : ceux des deux périodes comparées, tous étages confondus.
  const connus = useMemo(() => (donnees ? fluxConnus(donnees.a, donnees.b, aliasParCle, manuels) : []), [donnees, aliasParCle, manuels]);
  const transactionsGroupe = useMemo(
    () =>
      donnees && etage && groupe
        ? (trierTransactions(transactionsDuGroupe(donnees.a, donnees.b, etage, groupe, manuels), tri) as PartComparee[])
        : [],
    [donnees, etage, groupe, tri, manuels]
  );

  const choisirEtage = (suivant: EtagePnl) => {
    setEtage(etage === suivant ? null : suivant);
    setCategorie(null);
    setGroupe(null);
    setVoirTout(false);
  };
  const choisirCategorie = (cle: string) => {
    setCategorie(categorie === cle ? null : cle);
    setGroupe(null);
  };
  const ouvrirGroupe = (cle: string) => {
    setGroupe(cle);
    setTri(TRI_TRANSACTIONS_PAR_DEFAUT);
    setNombreAffiche(PAS_AFFICHAGE);
  };
  // Renommage d'un flux : le nom s'applique tout de suite, puis l'enregistrement ; en cas d'échec,
  // retour aux noms précédents. L'alias porte sur toutes les identités propres du groupe.
  const modifierAlias = (suivant: FlowAlias[], enregistrer: () => Promise<void>, etape: string) => {
    const precedent = aliasFlux;
    setAliasFlux(suivant);
    setRenommage(null);
    setErreurAlias(null);
    enregistrer().catch((error) => {
      const code = (error as { code?: string } | null)?.code ?? "inconnu";
      console.error(`[passe/alias] step=${etape} organization=${organizationId} code=${code}`);
      setAliasFlux(precedent);
      setErreurAlias("Le nom n'a pas pu être enregistré. Réessayez.");
    });
  };
  // Regroupement manuel : même principe (effet immédiat, puis enregistrement). Plusieurs écritures
  // se suivent ; si l'une échoue, l'état est relu en base plutôt que deviné.
  const modifierGroupes = (suivant: GroupeManuel[], enregistrer: () => Promise<void>, etape: string) => {
    setGroupesManuels(suivant);
    setErreurAlias(null);
    enregistrer().catch((error) => {
      const code = (error as { code?: string } | null)?.code ?? "inconnu";
      console.error(`[passe/groupes] step=${etape} organization=${organizationId} code=${code}`);
      setVersionGroupes((v) => v + 1);
      setErreurAlias("Le regroupement n'a pas pu être enregistré. Réessayez.");
    });
  };
  // Flux « connu » correspondant à une ligne : ses identités propres, avec leur nom détecté.
  const fluxDeLaLigne = (g: GroupeLibelle) => connus.find((f) => f.membres.some((m) => g.clesAlias.some((c) => c.cle === m.cle))) ?? null;
  const ouvrirFusion = (g: GroupeLibelle) => {
    setRenommage(null);
    setFusion({ cle: g.cle, recherche: "", cible: null, nom: g.groupeManuel?.nom ?? "", aDissocier: null });
  };
  const confirmerFusion = (g: GroupeLibelle) => {
    const courant = fluxDeLaLigne(g);
    const cible = fusion ? connus.find((f) => f.cle === fusion.cible) : undefined;
    const nom = fusion ? normaliserNomAlias(fusion.nom) : null;
    if (!courant || !cible || nom === null) return;
    const resultat = fusionnerFlux(groupesManuels, [...courant.membres, ...cible.membres], nom, crypto.randomUUID());
    setFusion(null);
    modifierGroupes(
      resultat.groupes,
      async () => {
        await enregistrerGroupeFlux(supabase!, organizationId, resultat.groupe);
        for (const id of resultat.supprimes) await supprimerGroupeFlux(supabase!, organizationId, id);
      },
      "merge"
    );
  };
  const dissocier = (cle: string) => {
    const resultat = dissocierFlux(groupesManuels, cle);
    setFusion(resultat.groupeSupprime || !fusion ? null : { ...fusion, aDissocier: null });
    modifierGroupes(
      resultat.groupes,
      () =>
        resultat.groupeSupprime
          ? supprimerGroupeFlux(supabase!, organizationId, resultat.groupeSupprime)
          : retirerFluxDuGroupe(supabase!, organizationId, cle),
      "unmerge"
    );
  };

  const enregistrerNom = (g: GroupeLibelle) => {
    const nom = renommage ? normaliserNomAlias(renommage.saisie) : null;
    if (nom === null || g.clesAlias.length === 0) return;
    // Un groupe manuel porte son propre nom : c'est lui qu'on renomme, pas les alias de ses flux.
    if (g.groupeManuel) {
      const id = g.groupeManuel.id;
      setRenommage(null);
      modifierGroupes(
        groupesManuels.map((x) => (x.id === id ? { ...x, nom } : x)),
        () => renommerGroupeFlux(supabase!, organizationId, id, nom),
        "rename"
      );
      return;
    }
    const cles = new Set(g.clesAlias.map((c) => c.cle));
    modifierAlias(
      [...aliasFlux.filter((a) => !cles.has(a.canonicalFlowKey)), ...g.clesAlias.map((c) => ({ canonicalFlowKey: c.cle, displayName: nom }))],
      () => sauvegarderAliasFlux(supabase!, organizationId, nom, g.libelleDetecte, g.clesAlias),
      "save"
    );
  };
  const reinitialiserNom = (g: GroupeLibelle) => {
    const cles = g.clesAlias.map((c) => c.cle);
    modifierAlias(
      aliasFlux.filter((a) => !cles.includes(a.canonicalFlowKey)),
      () => supprimerAliasFlux(supabase!, organizationId, cles),
      "reset"
    );
  };

  const changerPeriodes = (suivantes: SelectionsEcarts) => {
    onChangeSelections(suivantes);
    setGroupe(null);
  };

  // Panneau de fusion : la ligne concernée, son éventuel groupe manuel, les flux proposés (tous
  // sauf elle), et l'aperçu de ce que la fusion réunirait.
  const ligneFusion = fusion ? (groupes.find((g) => g.cle === fusion.cle) ?? null) : null;
  const groupeFusion = ligneFusion?.groupeManuel ? (groupesManuels.find((g) => g.id === ligneFusion.groupeManuel!.id) ?? null) : null;
  const fluxLigneFusion = ligneFusion ? fluxDeLaLigne(ligneFusion) : null;
  const sansAccents = (texte: string) => texte.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLocaleLowerCase("fr");
  const propositionsFusion =
    fusion && fluxLigneFusion
      ? connus.filter(
          (f) =>
            f.cle !== fluxLigneFusion.cle &&
            [f.libelle, ...f.membres.map((m) => m.nomDetecte)].some((nom) => sansAccents(nom).includes(sansAccents(fusion.recherche.trim())))
        )
      : [];
  const cibleFusion = fusion?.cible ? (connus.find((f) => f.cle === fusion.cible) ?? null) : null;
  const apercuFusion =
    fluxLigneFusion && cibleFusion
      ? [
          ...new Set(
            [
              ...(groupeFusion?.membres ?? []),
              ...fluxLigneFusion.membres,
              ...(groupesManuels.find((g) => g.id === cibleFusion.groupeManuel?.id)?.membres ?? []),
              ...cibleFusion.membres,
            ].map((m) => m.nomDetecte || m.exemple)
          ),
        ]
      : [];

  const libelleEtage = etage ? ETAGES_ECARTS.find((e) => e.etage === etage)!.libelle : null;
  const nomCategorie = categorie ? (categories.find((c) => c.cle === categorie)?.nom ?? null) : null;
  const groupeOuvert = groupe ? (groupes.find((g) => g.cle === groupe) ?? null) : null;
  const groupesStables = groupes.filter((g) => g.statut === "stable").length;
  const groupesAffiches = voirTout ? groupes : groupes.filter((g) => g.statut !== "stable");
  // Libellé d'un Cash flow : une période normalisée est une moyenne ramenée à une durée, jamais
  // présentée comme le chiffre réel de ses dates.
  // Période non terminée : elle ne contient que les transactions à ce jour. Si c'est elle qui est
  // normalisée, sa moyenne est calculée sur sa durée COMPLÈTE et se trouve donc sous-estimée — une
  // limite à dire, pas à corriger en silence.
  const periodesEnCours = (
    [
      ["A", periodeA],
      ["B", periodeB],
    ] as const
  ).filter(([, periode]) => periode.fin >= aujourdhui);

  const enTete = (cote: "A" | "B") => (normalisation?.cote === cote ? `${cote} (normalisé)` : cote);
  const libelleCashFlow = (cote: "A" | "B", periode: Periode) =>
    normalisation?.cote === cote
      ? `Cash flow ${cote} · ramené à ${normalisation.duree} (moyenne sur ${libellePeriode(periode)})`
      : `Cash flow ${cote} · ${libellePeriode(periode)}`;

  return (
    <div className="passe-detail">
      <div className="passe-detail__gauche">
        <div className="passe-ecarts__periodes">
          <div className="passe-controle passe-axe">
            <PasseSelecteurPeriode
              id="passe-ecarts-a"
              libelle="Période A"
              selection={selections.a}
              onChange={(a) => changerPeriodes({ ...selections, a })}
              aujourdhui={aujourdhui}
              configExercice={configExercice}
              catalogue={PRESETS_AVEC_MOIS}
            />
          </div>
          <div className="passe-controle passe-axe">
            <PasseSelecteurPeriode
              id="passe-ecarts-b"
              libelle="Période B"
              selection={selections.b}
              onChange={(b) => changerPeriodes({ ...selections, b })}
              aujourdhui={aujourdhui}
              configExercice={configExercice}
              catalogue={PRESETS_AVEC_MOIS}
            />
          </div>
        </div>

        {!periodesOk ? (
          <p className="login-erreur">Pour chaque période, la date de début doit précéder la date de fin.</p>
        ) : erreur ? (
          <div className="passe-etat">
            <p>{erreur}</p>
            <button type="button" className="btn-secondaire" onClick={() => setTentative((n) => n + 1)}>
              Réessayer
            </button>
          </div>
        ) : !comparaison ? (
          <div className="passe-etat">Chargement des deux périodes…</div>
        ) : (
          <>
            {normalisation && (
              <p className="login-info passe-ecarts__normalisation">
                <strong>Comparaison normalisée sur {normalisation.duree}.</strong> La période {normalisation.cote}, plus
                longue, est ramenée à {normalisation.duree} : ses montants sont des moyennes sur une durée équivalente, pas
                un historique.
              </p>
            )}

            {periodesEnCours.map(([cote, periode]) => (
              <p key={cote} className="passe-reserve">
                La période {cote} n&apos;est pas terminée (elle court jusqu&apos;au {formatDateCourte(periode.fin)}) : elle ne
                contient que les transactions enregistrées à ce jour.
                {normalisation?.cote === cote &&
                  ` Elle est pourtant ramenée à ${normalisation.duree} sur sa durée complète : sa moyenne est sous-estimée.`}
              </p>
            ))}

            <section className="passe-ecarts__kpi">
              <div>
                <p className="passe-ecarts__kpi-libelle">{libelleCashFlow("A", periodeA)}</p>
                <p className="passe-ecarts__kpi-valeur">{formatMontant(comparaison.cashFlowA)}</p>
              </div>
              <div>
                <p className="passe-ecarts__kpi-libelle">{libelleCashFlow("B", periodeB)}</p>
                <p className="passe-ecarts__kpi-valeur">{formatMontant(comparaison.cashFlowB)}</p>
              </div>
              <div>
                <p className="eyebrow">Écart</p>
                <p className="passe-ecarts__kpi-valeur">
                  <Contribution montant={comparaison.ecart} />
                </p>
                <p className="passe-kpi__ratio">
                  {comparaison.ecartRelatif === null ? "—" : `${comparaison.ecartRelatif > 0 ? "+" : ""}${formatPourcentage(comparaison.ecartRelatif)}`}
                </p>
              </div>
            </section>

            <section className="passe-structure">
              <h3 className="eyebrow eyebrow--encre">Ce qui fait varier le Cash flow</h3>
              <PasseWaterfallChart
                comparaison={comparaison}
                libelleA={enTete("A")}
                libelleB={enTete("B")}
                selection={etage}
                onSelect={choisirEtage}
              />
              {/* L'EBITDA s'explique par les quatre premiers étages ; l'Extra P&L n'intervient qu'après. */}
              <p className="passe-message">
                Dont variation d&apos;EBITDA : {signe(comparaison.variationEbitda)} · variation d&apos;Extra P&amp;L :{" "}
                {signe(comparaison.variationExtraPnl)}. Cliquez sur une contribution pour voir ses catégories.
              </p>
            </section>

            {etage && (
              <section className="passe-structure">
                <h3 className="eyebrow eyebrow--encre">{libelleEtage} · catégories</h3>
                {categories.length === 0 ? (
                  <p className="passe-structure__vide">Aucune catégorie mappée dans cet étage sur les deux périodes.</p>
                ) : (
                  <div className="table-wrapper">
                    <table className="passe-table">
                      <thead>
                        <tr>
                          <th>Catégorie</th>
                          <th className="col-montant">{enTete("A")}</th>
                          <th className="col-montant">{enTete("B")}</th>
                          <th className="col-montant">Impact Cash flow</th>
                        </tr>
                      </thead>
                      <tbody>
                        {categories.map((ligne) => (
                          <tr key={ligne.cle} className={categorie === ligne.cle ? "passe-ligne--selection" : undefined}>
                            <td className="passe-table__libelle">
                              {ligne.horsBanque ? (
                                <>
                                  {ligne.nom} <span className="passe-statut">Ajustement de gestion</span>
                                </>
                              ) : (
                                <button type="button" className="passe-lien-ligne" aria-pressed={categorie === ligne.cle} onClick={() => choisirCategorie(ligne.cle)}>
                                  {ligne.nom}
                                </button>
                              )}
                            </td>
                            <td className="col-montant passe-table__montant">{formatMontant(ligne.montantA)}</td>
                            <td className="col-montant passe-table__montant">{formatMontant(ligne.montantB)}</td>
                            <td className="col-montant passe-table__montant">
                              <Contribution montant={ligne.contribution} />
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </section>
            )}
          </>
        )}
      </div>

      <section className="passe-detail__droite">
        {!comparaison || !etage ? (
          <>
            <h3 className="eyebrow eyebrow--encre">Détail</h3>
            <p className="passe-structure__vide">
              Sélectionnez une contribution dans le graphique pour voir ce qui a changé entre les deux périodes.
            </p>
          </>
        ) : groupeOuvert ? (
          <>
            <h3 className="eyebrow eyebrow--encre">
              {groupeOuvert.libelle}
              <span className="passe-detail__compte"> {transactionsGroupe.length}</span>
            </h3>
            {groupeOuvert.alias && <p className="passe-detail__source">Flux détecté : {groupeOuvert.libelleDetecte}</p>}
            {groupeOuvert.groupeManuel && <p className="passe-detail__source">Regroupement manuel</p>}
            {normalisation && (
              <p className="passe-reserve">
                Les montants de comparaison sont normalisés sur {normalisation.duree}. Les transactions ci-dessous sont
                affichées à leur valeur réelle.
              </p>
            )}
            <div className="passe-tri">
              <button type="button" className="btn-secondaire" onClick={() => setGroupe(null)}>
                ← Retour
              </button>
              <span className="passe-filtres-actifs__titre">Trier par :</span>
              {TRIS.map((option) => (
                <button
                  key={option.cle}
                  type="button"
                  className={`btn-secondaire${tri === option.cle ? " btn-module--actif" : ""}`}
                  aria-pressed={tri === option.cle}
                  onClick={() => {
                    setTri(option.cle);
                    setNombreAffiche(PAS_AFFICHAGE);
                  }}
                >
                  {option.libelle}
                </button>
              ))}
            </div>
            <div className="passe-detail__table">
              <table className="passe-table">
                <thead>
                  <tr>
                    <th>Période</th>
                    <th>Date</th>
                    <th>Libellé</th>
                    <th className="col-montant">Montant</th>
                  </tr>
                </thead>
                <tbody>
                  {transactionsGroupe.slice(0, nombreAffiche).map((part) => (
                    <tr key={`${part.cote}:${part.transactionId}:${part.sourceCategoryId}`}>
                      <td>
                        <span className={`passe-statut passe-badge-periode passe-badge-periode--${part.cote.toLowerCase()}`}>{part.cote}</span>
                      </td>
                      <td className="passe-table__date">{formatDateCourte(part.transactionDate)}</td>
                      <td className="passe-table__libelle">
                        {part.label || "—"}
                        {/* Groupe manuel : le flux d'origine de chaque transaction reste lisible. */}
                        {groupeOuvert.groupeManuel && <span className="passe-detail__source">Flux : {buildCanonicalFlowIdentity(part.label).title}</span>}
                      </td>
                      <td className="col-montant passe-table__montant">
                        {formatMontant(part.montant)}
                        {part.weight !== 1 && (
                          <span className="passe-detail__source">
                            {formatPourcentage(part.weight)} de {formatMontant(part.montantSource)}
                          </span>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {transactionsGroupe.length > nombreAffiche && (
              <button type="button" className="btn-secondaire" onClick={() => setNombreAffiche((n) => n + PAS_AFFICHAGE)}>
                Afficher {PAS_AFFICHAGE} de plus
              </button>
            )}
          </>
        ) : (
          <>
            <h3 className="eyebrow eyebrow--encre">
              Ce qui change · {nomCategorie ?? libelleEtage}
              <span className="passe-detail__compte"> {groupesAffiches.length}</span>
            </h3>
            <p className="passe-reserve">
              Regroupement expérimental : les transactions d&apos;un même flux (même mandat de prélèvement, ou même
              contrepartie une fois retirés l&apos;habillage bancaire et les références) sont additionnées sur chaque
              période. Cliquez sur une ligne pour voir les transactions d&apos;origine.
            </p>
            {erreurAlias && <p className="login-erreur">{erreurAlias}</p>}
            {ligneFusion && fusion && (
              <section className="passe-fusion" aria-label="Fusion de flux">
                <h4 className="passe-fusion__titre">
                  {groupeFusion ? `Groupe « ${groupeFusion.nom} »` : `Fusionner « ${ligneFusion.libelle} » avec…`}
                </h4>
                {groupeFusion && (
                  <>
                    <p className="passe-renommage__aide">Membres :</p>
                    <ul className="passe-fusion__liste">
                      {groupeFusion.membres.map((membre) => {
                        const nomMembre = aliasParCle.get(membre.cle) ?? (membre.nomDetecte || membre.exemple || membre.cle);
                        return (
                          <li key={membre.cle}>
                            {fusion.aDissocier === membre.cle ? (
                              // Confirmation légère, sur place : pas de fenêtre modale.
                              <>
                                <span>
                                  Dissocier « {nomMembre} » du groupe « {groupeFusion.nom} » ?
                                </span>
                                <button type="button" className="btn-secondaire btn-module--actif" onClick={() => dissocier(membre.cle)}>
                                  Dissocier
                                </button>
                                <button type="button" className="btn-secondaire" onClick={() => setFusion({ ...fusion, aDissocier: null })}>
                                  Annuler
                                </button>
                              </>
                            ) : (
                              <>
                                <span>{nomMembre}</span>
                                <button type="button" className="passe-lien-ligne" onClick={() => setFusion({ ...fusion, aDissocier: membre.cle })}>
                                  Dissocier ce flux
                                </button>
                              </>
                            )}
                          </li>
                        );
                      })}
                    </ul>
                    <p className="passe-renommage__aide">Ajouter un flux ou un groupe :</p>
                  </>
                )}
                <input
                  type="search"
                  aria-label="Rechercher un flux à fusionner"
                  placeholder="Rechercher un flux ou un groupe…"
                  value={fusion.recherche}
                  autoFocus
                  onChange={(e) => setFusion({ ...fusion, recherche: e.target.value })}
                />
                {propositionsFusion.length === 0 ? (
                  <p className="passe-renommage__aide">Aucun autre flux ne correspond sur les deux périodes comparées.</p>
                ) : (
                  <ul className="passe-fusion__liste">
                    {propositionsFusion.slice(0, MAX_PROPOSITIONS_FUSION).map((f) => (
                      <li key={f.cle}>
                        <button
                          type="button"
                          className={`btn-secondaire${fusion.cible === f.cle ? " btn-module--actif" : ""}`}
                          aria-pressed={fusion.cible === f.cle}
                          onClick={() =>
                            setFusion({
                              ...fusion,
                              cible: f.cle,
                              nom: groupeFusion?.nom ?? f.groupeManuel?.nom ?? nomDeGroupePropose([ligneFusion.libelle, f.libelle]),
                            })
                          }
                        >
                          {f.libelle}
                        </button>
                        <span className="passe-renommage__aide">{f.groupeManuel ? "Regroupement manuel" : f.categorie}</span>
                      </li>
                    ))}
                  </ul>
                )}
                {propositionsFusion.length > MAX_PROPOSITIONS_FUSION && (
                  <p className="passe-renommage__aide">
                    {propositionsFusion.length - MAX_PROPOSITIONS_FUSION} autres flux : précisez la recherche.
                  </p>
                )}
                {cibleFusion && (
                  <form
                    className="passe-fusion__apercu"
                    onSubmit={(e) => {
                      e.preventDefault();
                      confirmerFusion(ligneFusion);
                    }}
                  >
                    <p className="passe-renommage__aide">Flux regroupés :</p>
                    <ul className="passe-fusion__liste">
                      {apercuFusion.map((nom) => (
                        <li key={nom}>{nom}</li>
                      ))}
                    </ul>
                    <label className="passe-fusion__nom">
                      <span className="passe-renommage__aide">Nom du groupe</span>
                      <input
                        type="text"
                        value={fusion.nom}
                        maxLength={LONGUEUR_MAX_ALIAS}
                        onChange={(e) => setFusion({ ...fusion, nom: e.target.value })}
                      />
                    </label>
                    <p className="passe-renommage__aide">
                      Leurs futures transactions rejoindront automatiquement ce groupe. Aucune transaction n&apos;est modifiée.
                    </p>
                    <div className="passe-tri">
                      <button type="submit" className="btn-secondaire btn-module--actif" disabled={normaliserNomAlias(fusion.nom) === null}>
                        Fusionner
                      </button>
                      <button type="button" className="btn-secondaire" onClick={() => setFusion(null)}>
                        Annuler
                      </button>
                    </div>
                  </form>
                )}
                {!cibleFusion && (
                  <div className="passe-tri">
                    <button type="button" className="btn-secondaire" onClick={() => setFusion(null)}>
                      Fermer
                    </button>
                  </div>
                )}
              </section>
            )}
            {groupesAffiches.length === 0 ? (
              <p className="passe-structure__vide">
                {groupes.length === 0 ? "Aucune transaction dans ce périmètre sur les deux périodes." : "Aucun changement : tout est stable."}
              </p>
            ) : (
              <div className="passe-detail__table">
                <table className="passe-table">
                  <thead>
                    <tr>
                      <th>Flux</th>
                      <th className="col-montant">{enTete("A")}</th>
                      <th className="col-montant">{enTete("B")}</th>
                      <th className="col-montant">Impact Cash flow</th>
                    </tr>
                  </thead>
                  <tbody>
                    {groupesAffiches.slice(0, nombreAffiche).map((g) => (
                      <tr key={g.cle}>
                        <td className="passe-table__libelle">
                          {renommage?.cle === g.cle ? (
                            <form
                              className="passe-renommage"
                              onSubmit={(e) => {
                                e.preventDefault();
                                enregistrerNom(g);
                              }}
                            >
                              <input
                                type="text"
                                aria-label={`Nouveau nom du flux ${g.libelleDetecte}`}
                                value={renommage.saisie}
                                maxLength={LONGUEUR_MAX_ALIAS}
                                autoFocus
                                onChange={(e) => setRenommage({ cle: g.cle, saisie: e.target.value })}
                                onKeyDown={(e) => {
                                  if (e.key === "Escape") setRenommage(null);
                                }}
                              />
                              <button type="submit" className="btn-secondaire btn-module--actif" disabled={normaliserNomAlias(renommage.saisie) === null}>
                                Enregistrer
                              </button>
                              <button type="button" className="btn-secondaire" onClick={() => setRenommage(null)}>
                                Annuler
                              </button>
                              {g.alias && (
                                <button type="button" className="passe-lien-ligne" onClick={() => reinitialiserNom(g)}>
                                  Réinitialiser le nom
                                </button>
                              )}
                              <span className="passe-renommage__aide">
                                {g.groupeManuel
                                  ? "Nom du regroupement : il s'applique à tous les flux qu'il réunit."
                                  : `Ce nom sera réutilisé automatiquement pour les futurs flux reconnus comme « ${g.libelleDetecte} ».`}
                              </span>
                            </form>
                          ) : (
                            <>
                              {/* Infobulle : pourquoi ces transactions sont réunies (méthode et confiance). */}
                              <button
                                type="button"
                                className="passe-lien-ligne"
                                title={
                                  g.groupeManuel
                                    ? "Regroupement manuel"
                                    : `Regroupement : ${METHODES[g.matchMethod]} (confiance ${Math.round(g.confidenceScore * 100)} %)`
                                }
                                onClick={() => ouvrirGroupe(g.cle)}
                              >
                                {g.libelle || "—"}
                              </button>
                              {/* Un flux sans identité ne peut pas être reconnu plus tard : ni renommage ni fusion. */}
                              {g.clesAlias.length > 0 && (
                                <span className="passe-flux-actions">
                                <button
                                  type="button"
                                  className="passe-renommer"
                                  aria-label="Renommer"
                                  data-infobulle="Renommer"
                                  onClick={() => {
                                    setFusion(null);
                                    setRenommage({ cle: g.cle, saisie: g.groupeManuel?.nom ?? g.alias ?? g.libelleDetecte });
                                  }}
                                >
                                  <span aria-hidden="true">✎</span>
                                </button>
                                <button
                                  type="button"
                                  className="passe-renommer"
                                  aria-label="Fusionner"
                                  data-infobulle="Fusionner"
                                  aria-expanded={fusion?.cle === g.cle}
                                  onClick={() => (fusion?.cle === g.cle ? setFusion(null) : ouvrirFusion(g))}
                                >
                                  <svg aria-hidden="true" viewBox="0 0 16 16" width="12" height="12" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
                                    <path d="M3 2v3.5C3 8 5 9 8 9s5 1 5 3.5V14M13 2v3.5C13 8 11 9 8 9" />
                                  </svg>
                                </button>
                                </span>
                              )}
                            </>
                          )}
                          {g.alias && renommage?.cle !== g.cle && <span className="passe-detail__source">Flux détecté : {g.libelleDetecte}</span>}
                          {g.groupeManuel && renommage?.cle !== g.cle && <span className="passe-detail__source">Regroupement manuel</span>}
                          {g.nombreA + g.nombreB > 1 && (
                            <span className="passe-statut">{g.nombreA + g.nombreB} transactions</span>
                          )}
                          {categorie === null && <span className="passe-detail__source">{g.categorie}</span>}
                        </td>
                        <td className="col-montant passe-table__montant">{g.nombreA === 0 ? "—" : formatMontant(g.montantA)}</td>
                        <td className="col-montant passe-table__montant">{g.nombreB === 0 ? "—" : formatMontant(g.montantB)}</td>
                        <td className="col-montant passe-table__montant">
                          <Contribution montant={g.contribution} />
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
            <div className="passe-tri">
              {groupesAffiches.length > nombreAffiche && (
                <button type="button" className="btn-secondaire" onClick={() => setNombreAffiche((n) => n + PAS_AFFICHAGE)}>
                  Afficher {PAS_AFFICHAGE} de plus
                </button>
              )}
              {groupesStables > 0 && (
                <button type="button" className="btn-secondaire" onClick={() => setVoirTout((v) => !v)}>
                  {voirTout ? "Masquer les lignes stables" : `Voir aussi les ${groupesStables} lignes stables`}
                </button>
              )}
            </div>
          </>
        )}
      </section>
    </div>
  );
}
