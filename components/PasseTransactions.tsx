"use client";

import MentionTTC from "./MentionTTC";
import Cartouche from "@/components/Cartouche";
import { useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import PasseEcarts, { SelectionsEcarts } from "./PasseEcarts";
import PasseObjectifs from "./PasseObjectifs";
import PasseGeneral from "./PasseGeneral";
import PasseMappingTable from "./PasseMappingTable";
import PasseSelecteurPeriode from "./PasseSelecteurPeriode";
import PasseSelecteurBase from "./PasseSelecteurBase";
import { BaseMontants, calculerPnlEnBase, partsEnBase, tauxParCategorie } from "@/lib/pastHtEstime";
import { DISCLAIMER_HT_ESTIME, DISCLAIMER_PASSE, PRECISION_HT_ESTIME } from "@/lib/pastPdfModel";
import { baseEnregistree, cleStockageBase, LIBELLE_ECARTS_EN_TTC, libelleCouverture } from "@/lib/pastHtEstime";
import PasseBfr from "./PasseBfr";
import PasseStocks from "./PasseStocks";
import PastDetailDashboard from "./PastDetailDashboard";
import OffreVerrouillee from "./OffreVerrouillee";
import IconCadenas from "./IconCadenas";
import { Capacite, DroitsOrganisation, messageOffreRequise } from "@/lib/offres";
import { supabase } from "@/lib/supabaseClient";
import { formatDateCourte, todayISO, toISODate } from "@/lib/dates";
import {
  cleStockagePeriode,
  ConfigExercice,
  descriptionExercice,
  deserialiserSelection,
  EXERCICE_PAR_DEFAUT,
  configExerciceValide,
  jourMaxDebutExercice,
  nomMoisExercice,
  periodeDeLaSelection,
  SelectionPeriode,
  selectionDuPreset,
  selectionParDefaut,
  serialiserSelection,
} from "@/lib/fiscalPeriods";
import { formatMontant, formatMontantComptable, MENTION_HT_ESTIME, MENTION_TTC } from "@/lib/format";
import { teintesParCategorie } from "@/lib/dataviz";
import {
  AjustementGestion,
  ajustementsDeLaPeriode,
  ajustementsDepuisStocks,
  StockFinDeMois,
} from "@/lib/pastAdjustments";
import { estMetriqueDetail, moisDeLaPeriode, partsMappees } from "@/lib/pastDetail";
import { entetePnl, nomFichierPdf, pageBfrPdf, pageEcartsPdf, pagesExportPdf } from "@/lib/pastPdfModel";
import { ChoixRapport, dernierMoisTermine, exercicesProposes, libelleExercice, moisProposes, planRapport, PlanRapport, resumeDuPlan } from "@/lib/pastPdfPeriodes";
import { chargerFacturesBfr, chargerSituationsValidees } from "@/lib/pastBfrRepository";
import { libelleMois } from "@/lib/pastDetail";
import { calculerPnl } from "@/lib/pastPnl";
import { donneesDeGestionACompleter, moisTerminesDeLaPeriode } from "@/lib/pastManagementData";
import {
  AnomalieSigne,
  anomaliesDeSigne,
  compterTransactionsAvecAnomalie,
  LIBELLES_ANOMALIE_SIGNE,
  repartirAnomalies,
  ValidationSigne,
} from "@/lib/pastSignChecks";
import {
  appliquerAxe,
  AxeAnalytique,
  categoriesDisponibles,
  compterNonCategorisees,
  estNonCategorisee,
  filtrerParCategories,
  libelleAxe,
  PastTransactionStockee,
  Periode,
  periodeValide,
  resoudreAxeAnalytique,
  transactionsCategorisees,
  trierParDateDecroissante,
} from "@/lib/pastTransactions";
import {
  compterAMapper,
  FiltreMapping,
  libelleEtagePnl,
  indexerMappings,
  lignesMapping,
  MappingCategorie,
  LIBELLE_ENCAISSEMENTS,
  DestinationMapping,
  decomposerDestination,
} from "@/lib/pastCategoryMapping";
import PasseRecurrence from "./PasseRecurrence";
import { recurrenceDuRevenu } from "@/lib/pastRecurrence";
import {
  annulerValidationSigne,
  chargerAxeConfigure,
  chargerCibles,
  commenterCibleEnBase,
  enregistrerCible,
  modifierCible,
  supprimerCible,
  chargerAjustementsGestion,
  chargerAxesAnalytiques,
  chargerExercice,
  chargerSansStock,
  chargerMappingsCategories,
  chargerStocks,
  chargerPastTransactions,
  chargerPremiereDateTransaction,
  chargerValidationsSigne,
  sauvegarderAxeConfigure,
  sauvegarderEtageCategorie,
  sauvegarderExercice,
  sauvegarderSansStock,
  sauvegarderStock,
  supprimerStock,
  validerSigne,
  sauvegarderTauxTvaCategorie,
} from "@/lib/pastTransactionsRepository";
import {
  Cible,
  commenterCible,
  corrigerCible,
  ecartsVsCibles,
  MESSAGE_CONFLIT_CIBLE,
  OperationCible,
  poserCible,
  remplacerCible,
  TypeCible,
} from "@/lib/pastTargets";

interface PasseTransactionsProps {
  organizationId: string;
  // Nom affiché en tête de l'export PDF et repris dans le nom du fichier.
  organizationName: string;
  accessToken: string;
  // Droits de l'offre de l'organisation, déjà résolus par la page avant tout affichage.
  droits: DroitsOrganisation;
}

const LIGNES_PAR_PAGE = 50;

// Onglets du module Passé. La période, choisie une fois, s'applique à tous.
// Deux groupes dans la navigation : à gauche ce qu'on CONSULTE (du général au particulier, dans
// l'ordre du P&L, puis l'analyse transversale), à droite ce qu'on RENSEIGNE ou configure.
const ONGLETS = [
  { cle: "general", libelle: "Général" },
  { cle: "ca", libelle: LIBELLE_ENCAISSEMENTS },
  // Offre Pilotage : quelle part des Encaissements provient d'un revenu récurrent. Juste après les
  // Encaissements, qu'il ventile sans les remplacer.
  { cle: "recurrence", libelle: "Revenu récurrent" },
  { cle: "marge_brute", libelle: "Marge brute" },
  { cle: "marge_contributive", libelle: "Marge contributive" },
  { cle: "ebitda", libelle: "EBITDA" },
  { cle: "cash_flow", libelle: "Cash flow" },
  // Toujours HT, sur factures Pennylane et stocks : ne dépend ni de la lecture HT estimé / TTC ni
  // des transactions de la période.
  { cle: "bfr", libelle: "BFR" },
  // Dernier du groupe de consultation : ce n'est pas un étage de plus du P&L mais une lecture
  // transversale. Mis en avant (rose de marque) même au repos, pour être repéré d'emblée.
  { cle: "ecarts", libelle: "Analyse d'écarts", vedette: true },
  { cle: "stocks", libelle: "Stocks", actions: true },
  // Objectifs : « quel niveau de performance est attendu ? ». Correspondance P&L : « où va cette
  // catégorie ? ». Deux écrans, deux questions.
  { cle: "objectifs", libelle: "Objectifs", actions: true },
  { cle: "mapping", libelle: "Correspondance P&L", actions: true },
  // Plus proposé dans la navigation : une liste brute de transactions, sans contexte, n'explique
  // aucun chiffre. Les transactions se consultent dans les écrans de détail, par étage, catégorie
  // et mois. La vue reste définie (rien d'autre n'est retiré) mais n'est plus atteignable.
  { cle: "transactions", libelle: "Transactions", horsNavigation: true },
] as const;

type Vue = (typeof ONGLETS)[number]["cle"];

// Onglets soumis à une capacité de l'offre (lib/offres.ts) ; les autres suivent l'accès au module.
const CAPACITE_PAR_VUE: Partial<Record<Vue, { capacite: Capacite; fonctionnalite: string }>> = {
  ecarts: { capacite: "canViewVarianceAnalysis", fonctionnalite: "L'analyse d'écarts" },
  bfr: { capacite: "canViewWorkingCapital", fonctionnalite: "Le BFR" },
  recurrence: { capacite: "canViewRevenueRecurrence", fonctionnalite: "La récurrence du revenu" },
};

function vueVerrouillee(vue: Vue, droits: DroitsOrganisation): boolean {
  const restriction = CAPACITE_PAR_VUE[vue];
  return restriction !== undefined && !droits.capacites[restriction.capacite];
}
const formatNombre = new Intl.NumberFormat("fr-FR");

function pluriel(nombre: number, singulier: string, plurielTexte: string): string {
  return `${formatNombre.format(nombre)} ${nombre > 1 ? plurielTexte : singulier}`;
}

// Tableau des transactions du module Passé. Lit uniquement past_transactions (jamais Pennylane
// directement) : la source d'une transaction n'a aucune incidence sur l'affichage.
export default function PasseTransactions({ organizationId, organizationName, accessToken, droits }: PasseTransactionsProps) {
  const router = useRouter();
  // PÉRIODE DU MODULE — source unique pour tous les onglets. Elle tient en deux états :
  //  - l'exercice de l'organisation (en base ; null tant qu'il n'est pas lu) ;
  //  - la sélection de l'utilisateur : un preset, dont les dates se recalculent, ou des dates
  //    libres. Relue du stockage local de CETTE organisation au montage, puis réécrite à chaque
  //    changement ; null = jamais choisie, donc « Exercice en cours ».
  const aujourdhui = todayISO();
  const [exercice, setExercice] = useState<ConfigExercice | null>(null);
  const [selection, setSelection] = useState<SelectionPeriode | null>(() => {
    try {
      return deserialiserSelection(window.localStorage.getItem(cleStockagePeriode(organizationId)));
    } catch {
      return null;
    }
  });
  const configExercice = exercice ?? EXERCICE_PAR_DEFAUT;
  const selectionCourante = selection ?? selectionParDefaut(aujourdhui, configExercice);
  const bornes = periodeDeLaSelection(selectionCourante, aujourdhui, configExercice);
  // Même objet tant que les dates ne changent pas : la période sert de dépendance à des effets.
  const periode = useMemo<Periode>(() => ({ debut: bornes.debut, fin: bornes.fin }), [bornes.debut, bornes.fin]);

  const choisirPeriode = (suivante: SelectionPeriode) => {
    setSelection(suivante);
    try {
      window.localStorage.setItem(cleStockagePeriode(organizationId), serialiserSelection(suivante));
    } catch {
      // Stockage local indisponible (navigation privée, quota) : la période reste valable pour la
      // session en cours, elle ne sera simplement pas restaurée au prochain chargement.
    }
  };

  const [reglageExerciceOuvert, setReglageExerciceOuvert] = useState(false);
  // Saisie en cours du début d'exercice. jour null = à (re)saisir : une combinaison jour/mois qui
  // n'existe pas tous les ans (31 avril, 29 février) vide le jour au lieu d'être corrigée d'office.
  const [brouillonExercice, setBrouillonExercice] = useState<{ mois: number; jour: number | null }>(EXERCICE_PAR_DEFAUT);
  const [jourExerciceRefuse, setJourExerciceRefuse] = useState(false);
  const [erreurExercice, setErreurExercice] = useState<string | null>(null);
  const [enregistrementExercice, setEnregistrementExercice] = useState(false);
  const reglageExerciceRef = useRef<HTMLDivElement>(null);
  // Transactions telles que stockées (avec toutes leurs affectations analytiques) ; la catégorie
  // affichée en est dérivée plus bas, selon l'axe analytique retenu.
  const [stockees, setStockees] = useState<PastTransactionStockee[]>([]);
  const [axes, setAxes] = useState<AxeAnalytique[]>([]);
  const [axeConfigure, setAxeConfigure] = useState<string | null>(null);
  const [erreurAxe, setErreurAxe] = useState<string | null>(null);
  // Correspondance catégorie -> étage P&L : indépendante de la période, toujours accessible.
  const [mappings, setMappings] = useState<MappingCategorie[]>([]);
  const [vue, setVue] = useState<Vue>("general");
  // Lecture des montants (HT estimé par défaut, ou TTC) : état du module, conservé d'un onglet à
  // l'autre et, comme la période, relu du stockage local de CETTE organisation au montage. Seul un
  // choix explicite y est écrit : une préférence TTC reste TTC. Ne modifie aucune donnée ; la
  // trésorerie reste TTC dans les deux lectures.
  const [base, setBase] = useState<BaseMontants>(() => {
    try {
      return baseEnregistree(window.localStorage.getItem(cleStockageBase(organizationId)));
    } catch {
      return baseEnregistree(null);
    }
  });
  const choisirBase = (suivante: BaseMontants) => {
    setBase(suivante);
    try {
      window.localStorage.setItem(cleStockageBase(organizationId), suivante);
    } catch {
      // Stockage local indisponible : la lecture vaut pour la session en cours seulement.
    }
  };
  const [filtreMapping, setFiltreMapping] = useState<FiltreMapping>("toutes");
  const [erreurMapping, setErreurMapping] = useState<string | null>(null);
  const [detailSignesOuvert, setDetailSignesOuvert] = useState(false);
  // Anomalies de signe que l'utilisateur a vérifiées et acceptées (en base, par organisation).
  const [validationsSigne, setValidationsSigne] = useState<ValidationSigne[]>([]);
  const [vueSignes, setVueSignes] = useState<"a_verifier" | "validees">("a_verifier");
  // Cibles de performance de l'organisation (en base), toutes dates d'effet confondues.
  const [cibles, setCibles] = useState<Cible[]>([]);
  const [erreurCible, setErreurCible] = useState<string | null>(null);
  const [messageSigne, setMessageSigne] = useState<string | null>(null);
  const [erreurSigne, setErreurSigne] = useState<string | null>(null);
  // Ajustements de gestion : ceux saisis tels quels, et les stocks de fin de mois dont dérive la
  // variation de stock. Les deux séries sont chargées entières (indépendantes de la période).
  const [ajustementsSaisis, setAjustementsSaisis] = useState<AjustementGestion[]>([]);
  const [stocks, setStocks] = useState<StockFinDeMois[]>([]);
  const [erreurStock, setErreurStock] = useState<string | null>(null);
  // Organisation déclarée sans stock : retire le signal « stocks non renseignés ».
  const [sansStock, setSansStock] = useState(false);
  const [chargement, setChargement] = useState(true);
  const [erreurChargement, setErreurChargement] = useState<string | null>(null);
  const [rechargement, setRechargement] = useState(0);

  const [selectionCategories, setSelectionCategories] = useState<Set<string>>(new Set());
  const [filtreOuvert, setFiltreOuvert] = useState(false);
  const filtreRef = useRef<HTMLDivElement>(null);
  const [page, setPage] = useState(0);

  // null = pas encore su ; même source d'information que le cockpit (/api/pennylane/status).
  const [pennylaneConnecte, setPennylaneConnecte] = useState<boolean | null>(null);
  const [syncEnCours, setSyncEnCours] = useState(false);
  const [syncMessage, setSyncMessage] = useState<string | null>(null);
  const [syncErreur, setSyncErreur] = useState<string | null>(null);
  // Export PDF : UNE période choisie au moment de l'export (un mois ou un exercice), traduite pour
  // chaque section (lib/pastPdfPeriodes.ts). Indépendante de la période et des filtres de l'écran.
  const [exportEnCours, setExportEnCours] = useState(false);
  const [exportErreur, setExportErreur] = useState<string | null>(null);
  const [exportOuvert, setExportOuvert] = useState(false);
  const exportRef = useRef<HTMLDivElement>(null);
  const [choixExport, setChoixExport] = useState<ChoixRapport>(() => ({ type: "mois", mois: dernierMoisTermine(todayISO()) }));
  // Plus ancienne transaction : borne des mois et exercices proposés. undefined = pas encore lue.
  const [premiereDate, setPremiereDate] = useState<string | null | undefined>(undefined);

  const periodeOk = periodeValide(periode);

  useEffect(() => {
    let annule = false;
    fetch("/api/pennylane/status", { headers: { Authorization: `Bearer ${accessToken}` } })
      .then((res) => (res.ok ? res.json() : { connected: false }))
      .then((data) => {
        if (!annule) setPennylaneConnecte(Boolean(data.connected));
      })
      .catch(() => {
        if (!annule) setPennylaneConnecte(false);
      });
    return () => {
      annule = true;
    };
  }, [accessToken]);

  useEffect(() => {
    let annule = false;
    chargerExercice(supabase!, organizationId)
      .then((config) => {
        if (!annule) setExercice(config);
      })
      .catch((error) => {
        if (annule) return;
        // Sans exercice lisible, le module reste utilisable sur l'année civile.
        console.error("Échec de la lecture de l'exercice du module Passé :", error);
        setExercice(EXERCICE_PAR_DEFAUT);
      });
    return () => {
      annule = true;
    };
  }, [organizationId]);

  useEffect(() => {
    let annule = false;
    chargerSansStock(supabase!, organizationId)
      .then((valeur) => {
        if (!annule) setSansStock(valeur);
      })
      .catch((error) => {
        if (annule) return;
        const code = (error as { code?: string } | null)?.code ?? "inconnu";
        console.error(`[passe/stocks] step=load-no-inventory organization=${organizationId} code=${code}`);
      });
    return () => {
      annule = true;
    };
  }, [organizationId]);

  useEffect(() => {
    if (!reglageExerciceOuvert) return;
    const gererClicExterieur = (e: MouseEvent) => {
      if (reglageExerciceRef.current && !reglageExerciceRef.current.contains(e.target as Node)) setReglageExerciceOuvert(false);
    };
    document.addEventListener("mousedown", gererClicExterieur);
    return () => document.removeEventListener("mousedown", gererClicExterieur);
  }, [reglageExerciceOuvert]);

  useEffect(() => {
    // L'exercice détermine les dates d'un preset : on attend de le connaître avant de charger.
    if (exercice === null) return;
    if (!periodeOk) {
      setStockees([]);
      setChargement(false);
      setErreurChargement(null);
      return;
    }
    let annule = false;
    setChargement(true);
    setErreurChargement(null);
    Promise.all([
      chargerPastTransactions(supabase!, organizationId, periode),
      chargerAxesAnalytiques(supabase!, organizationId),
      chargerAxeConfigure(supabase!, organizationId),
      chargerMappingsCategories(supabase!, organizationId),
      chargerStocks(supabase!, organizationId),
      chargerAjustementsGestion(supabase!, organizationId),
    ])
      .then(([lignes, axesConnus, axeChoisi, mappingsConnus, stocksConnus, ajustementsConnus]) => {
        if (annule) return;
        setStockees(trierParDateDecroissante(lignes));
        setAxes(axesConnus);
        setAxeConfigure(axeChoisi);
        setMappings(mappingsConnus);
        setStocks(stocksConnus);
        setAjustementsSaisis(ajustementsConnus);
        setChargement(false);
      })
      .catch((error) => {
        if (annule) return;
        console.error("Échec du chargement des transactions du module Passé :", error);
        setStockees([]);
        setErreurChargement("Impossible de charger les transactions pour le moment.");
        setChargement(false);
      });
    // Chargées à part : sans elles, le reporting s'affiche quand même, simplement sans cible.
    chargerCibles(supabase!, organizationId)
      .then((connues) => {
        if (!annule) setCibles(connues);
      })
      .catch((error) => {
        const code = (error as { code?: string } | null)?.code ?? "inconnu";
        console.error(`[passe/cibles] step=load organization=${organizationId} code=${code}`);
      });
    // Chargées à part : si elles sont indisponibles, le reporting s'affiche quand même et toutes
    // les anomalies restent simplement « à vérifier ».
    chargerValidationsSigne(supabase!, organizationId)
      .then((validations) => {
        if (!annule) setValidationsSigne(validations);
      })
      .catch((error) => {
        const code = (error as { code?: string } | null)?.code ?? "inconnu";
        console.error(`[passe/signes] step=load organization=${organizationId} code=${code}`);
      });
    return () => {
      annule = true;
    };
  }, [organizationId, periode, periodeOk, rechargement, exercice]);

  useEffect(() => {
    if (!exportOuvert) return;
    const gererClicExterieur = (e: MouseEvent) => {
      if (exportRef.current && !exportRef.current.contains(e.target as Node)) setExportOuvert(false);
    };
    document.addEventListener("mousedown", gererClicExterieur);
    return () => document.removeEventListener("mousedown", gererClicExterieur);
  }, [exportOuvert]);

  useEffect(() => {
    if (!filtreOuvert) return;
    const gererClicExterieur = (e: MouseEvent) => {
      if (filtreRef.current && !filtreRef.current.contains(e.target as Node)) setFiltreOuvert(false);
    };
    document.addEventListener("mousedown", gererClicExterieur);
    return () => document.removeEventListener("mousedown", gererClicExterieur);
  }, [filtreOuvert]);

  // Axe analytique utilisé : celui choisi par l'organisation, sinon l'axe unique s'il n'y en a
  // qu'un ; avec plusieurs axes et aucun choix, aucun n'est retenu (état "à configurer").
  const axe = useMemo(() => resoudreAxeAnalytique(axes, axeConfigure), [axes, axeConfigure]);
  const axeAConfigurer = axe.etat === "a_configurer";
  const transactions = useMemo(() => appliquerAxe(stockees, axe.axeId), [stockees, axe.axeId]);

  const categories = useMemo(() => categoriesDisponibles(transactions), [transactions]);
  // Le compteur suit la période uniquement : calculé sur toutes les transactions chargées, jamais
  // sur le résultat du filtre catégorie.
  const nombreNonCategorisees = useMemo(() => compterNonCategorisees(transactions), [transactions]);
  // Rappel "dans Pennylane" seulement si c'est bien là que la catégorisation doit être faite.
  const nonCategoriseesToutesPennylane = useMemo(
    () => transactions.every((t) => !estNonCategorisee(t) || t.sourceType === "pennylane"),
    [transactions]
  );
  // Le tableau n'expose que les transactions catégorisées : les autres ne sont pas modifiables
  // dans Novanta, elles sont seulement comptées dans l'alerte.
  const categorisees = useMemo(() => transactionsCategorisees(transactions), [transactions]);

  // Une catégorie sélectionnée puis absente de la nouvelle période ne doit pas vider le tableau
  // en silence : seules les clés encore proposées comptent.
  const selectionEffective = useMemo(() => {
    const proposees = new Set<string>(categories);
    return new Set([...selectionCategories].filter((cle) => proposees.has(cle)));
  }, [selectionCategories, categories]);

  const transactionsFiltrees = useMemo(
    () => filtrerParCategories(categorisees, selectionEffective),
    [categorisees, selectionEffective]
  );

  // Tableau de correspondance : toutes les catégories connues de l'axe retenu, avec leur activité
  // sur la période. Le compteur "à mapper" porte sur ces catégories, quelle que soit la période.
  // Nature du revenu (offre Pilotage) : les deux lignes « Encaissements : revenu récurrent /
  // ponctuel » remplacent « Encaissements », et une catégorie d'Encaissements sans nature compte
  // parmi les catégories à mapper. Seulement si la colonne existe en base (natureDisponible).
  const natureDisponible = mappings.length === 0 || mappings.some((m) => m.revenueNature !== undefined);
  const natureActive = droits.capacites.canViewRevenueRecurrence && natureDisponible;
  const lignesCorrespondance = useMemo(
    () => lignesMapping(mappings, axe.axeId, stockees, natureActive),
    [mappings, axe.axeId, stockees, natureActive]
  );
  const nombreAMapper = useMemo(() => compterAMapper(lignesCorrespondance, natureActive), [lignesCorrespondance, natureActive]);

  // P&L de la période : transaction -> catégories pondérées -> mapping courant -> étage. Recalculé
  // dès qu'un mapping change, sans relire ni réécrire les transactions.
  const mappingsIndexes = useMemo(() => indexerMappings(mappings), [mappings]);
  // Ajustements de gestion de la période, toutes natures confondues : ceux saisis tels quels et
  // les variations de stock, calculées à partir de la série entière des stocks.
  const tousLesAjustements = useMemo(
    () => [...ajustementsSaisis, ...ajustementsDepuisStocks(stocks)],
    [ajustementsSaisis, stocks]
  );
  const ajustements = useMemo(() => ajustementsDeLaPeriode(tousLesAjustements, periode), [tousLesAjustements, periode]);
  // Périodes comparées dans l'onglet Écarts : état du module, donc conservé quand on change
  // d'onglet puis qu'on y revient. null = jamais modifiées : M-2 contre M-1, en mois civils.
  const [selectionsEcarts, setSelectionsEcarts] = useState<SelectionsEcarts | null>(null);
  // Lecture de l'Analyse d'écarts (hors financement par défaut). Simple état du module : jamais
  // enregistré, il revient à sa valeur par défaut au rechargement de la page.
  const [ecartsFinancementCompris, setEcartsFinancementCompris] = useState(false);
  const selectionsEcartsCourantes: SelectionsEcarts = selectionsEcarts ?? {
    a: selectionDuPreset("mois_m2", aujourdhui, configExercice),
    b: selectionDuPreset("mois_m1", aujourdhui, configExercice),
  };
  const pnl = useMemo(
    () => calculerPnl(stockees, axe.axeId, mappingsIndexes, ajustements),
    [stockees, axe.axeId, mappingsIndexes, ajustements]
  );
  // Données de gestion à compléter sur la période (stocks...) : signalées à côté des indicateurs
  // de transactions, jamais bloquantes. Recalculées dès qu'un stock est saisi ou retiré.
  const donneesACompleter = useMemo(
    () => (periodeOk ? donneesDeGestionACompleter({ stocks, sansStock, periode, aujourdhui }) : []),
    [stocks, sansStock, periode, periodeOk, aujourdhui]
  );
  // Signes inhabituels sur la période : signalés seulement, jamais corrigés ni exclus du P&L.
  const anomaliesSigne = useMemo(
    () => anomaliesDeSigne(stockees, axe.axeId, mappingsIndexes),
    [stockees, axe.axeId, mappingsIndexes]
  );
  // Les anomalies validées par l'utilisateur sortent de la liste à vérifier, sans rien changer aux
  // calculs ; le compteur et l'alerte ne portent plus que sur ce qui reste à vérifier.
  const signes = useMemo(() => repartirAnomalies(anomaliesSigne, validationsSigne), [anomaliesSigne, validationsSigne]);
  const nombreSignesInhabituels = useMemo(() => compterTransactionsAvecAnomalie(signes.aVerifier), [signes.aVerifier]);
  const nombreSignesValides = useMemo(() => compterTransactionsAvecAnomalie(signes.validees), [signes.validees]);
  // Une catégorie = une teinte, fixée sur la période entière et partagée par tous les onglets.
  const teintesCategories = useMemo(() => teintesParCategorie(pnl.categories), [pnl.categories]);
  // Écrans détaillés : parts mappées de la période, matière commune du KPI, du camembert, de
  // l'histogramme et de la liste de transactions de chaque écran.
  const partsDetail = useMemo(
    () => partsMappees(stockees, axe.axeId, mappingsIndexes),
    [stockees, axe.axeId, mappingsIndexes]
  );
  // Lecture affichée — écrans, objectifs et export PDF. pnl et partsDetail restent TTC : ils
  // servent aux anomalies et à la trésorerie (Cash flow), qui ne changent pas de base.
  const pnlAffiche = useMemo(
    () => calculerPnlEnBase(stockees, axe.axeId, mappingsIndexes, ajustements, base),
    [stockees, axe.axeId, mappingsIndexes, ajustements, base]
  );
  const partsDetailAffichees = useMemo(
    () => partsEnBase(partsDetail, tauxParCategorie(mappingsIndexes), base),
    [partsDetail, mappingsIndexes, base]
  );
  // Récurrence du revenu (offre Pilotage) : les parts d'Encaissements de la lecture affichée,
  // réparties selon la nature de leur catégorie (lib/pastRecurrence.ts).
  const recurrence = useMemo(
    () => recurrenceDuRevenu(partsDetailAffichees, mappingsIndexes, ajustements, periode),
    [partsDetailAffichees, mappingsIndexes, ajustements, periode]
  );
  // Réalisé de la période face aux cibles en vigueur : lu dans Général. Les objectifs sont
  // exclusivement HT — en lecture TTC, aucune cible ni aucun écart n'est calculé (null).
  const ecartsCibles = useMemo(
    () => (base === "ht" ? ecartsVsCibles(cibles, partsDetailAffichees, ajustements, periode) : null),
    [cibles, partsDetailAffichees, ajustements, periode, base]
  );

  // Une catégorie -> une ligne analytique : l'étage, et en Encaissements la nature du revenu
  // (offre Pilotage). Hors Encaissements, la nature est effacée ; sans la colonne en base, elle
  // n'est jamais écrite. Changer la nature reclasse tout l'historique de la catégorie, à la lecture.
  const changerDestination = (sourceCategoryId: string, destination: DestinationMapping) => {
    const mapping = mappings.find((m) => m.sourceCategoryId === sourceCategoryId);
    if (!mapping) return;
    const { etage, nature: natureChoisie } = decomposerDestination(destination);
    const precedent = { pnlStage: mapping.pnlStage, revenueNature: mapping.revenueNature };
    // Hors offre Pilotage, « Encaissements » garde la nature éventuellement déjà posée.
    const nature = etage !== "revenue" ? null : natureActive ? natureChoisie : (mapping.revenueNature ?? null);
    if (precedent.pnlStage === etage && (precedent.revenueNature ?? null) === nature) return;
    const appliquer = (valeur: Pick<MappingCategorie, "pnlStage" | "revenueNature">) =>
      setMappings((prev) =>
        prev.map((m) =>
          m.sourceCategoryId === sourceCategoryId ? { ...m, pnlStage: valeur.pnlStage, ...(natureDisponible ? { revenueNature: valeur.revenueNature ?? null } : {}) } : m
        )
      );
    appliquer({ pnlStage: etage, revenueNature: nature });
    setErreurMapping(null);
    sauvegarderEtageCategorie(supabase!, organizationId, sourceCategoryId, etage, natureDisponible ? nature : undefined).catch((error) => {
      const code = (error as { code?: string } | null)?.code ?? "inconnu";
      console.error(
        `[passe/mapping] step=update_pnl_stage organization=${organizationId} category=${sourceCategoryId} code=${code}`
      );
      appliquer(precedent);
      setErreurMapping("Le mapping n'a pas pu être enregistré. Réessayez.");
    });
  };

  // Taux de TVA estimé d'une catégorie : affiché et appliqué tout de suite, puis enregistré ; en
  // cas d'échec, retour au taux précédent.
  const changerTauxTva = (sourceCategoryId: string, taux: number | null) => {
    const precedent = mappings.find((m) => m.sourceCategoryId === sourceCategoryId)?.vatRate ?? null;
    if (precedent === taux) return;
    const appliquer = (valeur: number | null) =>
      setMappings((prev) => prev.map((m) => (m.sourceCategoryId === sourceCategoryId ? { ...m, vatRate: valeur } : m)));
    appliquer(taux);
    setErreurMapping(null);
    sauvegarderTauxTvaCategorie(supabase!, organizationId, sourceCategoryId, taux).catch((error) => {
      const code = (error as { code?: string } | null)?.code ?? "inconnu";
      console.error(`[passe/mapping] step=update_vat_rate organization=${organizationId} category=${sourceCategoryId} code=${code}`);
      appliquer(precedent);
      setErreurMapping("Le taux de TVA n'a pas pu être enregistré. Réessayez.");
    });
  };

  // Stocks : mise à jour immédiate à l'écran (les variations se recalculent seules), puis
  // enregistrement ; en cas d'échec, retour à la série précédente.
  const modifierStocks = (suivant: StockFinDeMois[], enregistrer: () => Promise<void>, mois: string) => {
    const precedent = stocks;
    setStocks(suivant);
    setErreurStock(null);
    enregistrer().catch((error) => {
      const code = (error as { code?: string } | null)?.code ?? "inconnu";
      console.error(`[passe/stocks] step=save organization=${organizationId} month=${mois} code=${code}`);
      setStocks(precedent);
      setErreurStock("Le stock n'a pas pu être enregistré. Réessayez.");
    });
  };
  const enregistrerStock = (mois: string, valeur: number) =>
    modifierStocks(
      [...stocks.filter((s) => s.mois !== mois), { mois, valeur }],
      () => sauvegarderStock(supabase!, organizationId, mois, valeur),
      mois
    );
  const declarerSansStock = (valeur: boolean) => {
    const precedent = sansStock;
    setSansStock(valeur);
    setErreurStock(null);
    sauvegarderSansStock(supabase!, organizationId, valeur).catch((error) => {
      const code = (error as { code?: string } | null)?.code ?? "inconnu";
      console.error(`[passe/stocks] step=save-no-inventory organization=${organizationId} code=${code}`);
      setSansStock(precedent);
      setErreurStock("Le réglage n'a pas pu être enregistré. Réessayez.");
    });
  };
  const retirerStock = (mois: string) =>
    modifierStocks(
      stocks.filter((s) => s.mois !== mois),
      () => supprimerStock(supabase!, organizationId, mois),
      mois
    );

  // Validation d'un signe inhabituel : la ligne change de liste tout de suite, puis
  // l'enregistrement ; en cas d'échec, retour à l'état précédent.
  useEffect(() => {
    if (!messageSigne) return;
    const minuteur = setTimeout(() => setMessageSigne(null), 3000);
    return () => clearTimeout(minuteur);
  }, [messageSigne]);
  const modifierValidations = (suivant: ValidationSigne[], enregistrer: () => Promise<void>, message: string, etape: string) => {
    const precedent = validationsSigne;
    setValidationsSigne(suivant);
    setErreurSigne(null);
    setMessageSigne(message);
    enregistrer().catch((error) => {
      const code = (error as { code?: string } | null)?.code ?? "inconnu";
      console.error(`[passe/signes] step=${etape} organization=${organizationId} code=${code}`);
      setValidationsSigne(precedent);
      setMessageSigne(null);
      setErreurSigne("La modification n'a pas pu être enregistrée. Réessayez.");
    });
  };
  const memePart = (v: ValidationSigne, a: AnomalieSigne) => v.transactionId === a.transactionId && v.sourceCategoryId === a.sourceCategoryId;
  const validerAnomalie = (a: AnomalieSigne) => {
    const validation = { transactionId: a.transactionId, sourceCategoryId: a.sourceCategoryId, etage: a.etage, type: a.type };
    modifierValidations(
      [...validationsSigne.filter((v) => !memePart(v, a)), { ...validation, validatedAt: new Date().toISOString() }],
      () => validerSigne(supabase!, organizationId, validation),
      "Transaction validée",
      "validate"
    );
  };
  const annulerValidation = (a: AnomalieSigne) =>
    modifierValidations(
      validationsSigne.filter((v) => !memePart(v, a)),
      () => annulerValidationSigne(supabase!, organizationId, a.transactionId, a.sourceCategoryId),
      "Validation annulée",
      "unvalidate"
    );

  // Objectifs : la modification se voit tout de suite, puis les écritures décidées par
  // lib/pastTargets.ts sont appliquées dans l'ordre. En cas d'échec, l'état réel est relu en base
  // (une écriture a pu passer avant celle qui échoue) et un message explicite s'affiche.
  const appliquerOperations = async (operations: OperationCible[]) => {
    for (const operation of operations) {
      if (operation.type === "insert") {
        const { cible } = operation;
        const enregistree = await enregistrerCible(supabase!, organizationId, cible.type, cible.dimension, cible.validFrom, cible.valeur);
        setCibles((actuelles) => actuelles.map((c) => (c.id === cible.id ? enregistree : c)));
      } else if (operation.type === "update") {
        await modifierCible(supabase!, organizationId, operation.id, { valeur: operation.valeur, validFrom: operation.validFrom });
      } else if (operation.type === "comment") {
        await commenterCibleEnBase(supabase!, organizationId, operation.id, operation.commentaire);
      } else {
        await supprimerCible(supabase!, organizationId, operation.id);
      }
    }
  };
  const enregistrerCibles = (resultat: { cibles: Cible[]; operations: OperationCible[] }, etape: string, messageEchec: string) => {
    setErreurCible(null);
    if (resultat.operations.length === 0) return;
    setCibles(resultat.cibles);
    appliquerOperations(resultat.operations).catch((error) => {
      const code = (error as { code?: string } | null)?.code ?? "inconnu";
      console.error(`[passe/cibles] step=${etape} organization=${organizationId} code=${code}`);
      // 23505 : unicité — une autre cible porte déjà cette date d'effet en base.
      setErreurCible(code === "23505" ? MESSAGE_CONFLIT_CIBLE : messageEchec);
      chargerCibles(supabase!, organizationId)
        .then(setCibles)
        .catch(() => undefined);
    });
  };
  // `dimension` : la catégorie de CA d'un objectif de marge ; vide pour les coûts de structure.
  // Posée à une date d'effet déjà utilisée pour la même cible, la valeur la met à jour.
  const poserUneCible = (type: TypeCible, dimension: string, validFrom: string, valeur: number) =>
    enregistrerCibles(
      poserCible(cibles, { type, dimension, validFrom }, valeur, `provisoire:${type}:${dimension}:${validFrom}`),
      "save",
      "La cible n'a pas pu être enregistrée. Réessayez."
    );
  // Correction de LA cible désignée par son identifiant. L'écran ne l'appelle qu'en l'absence de
  // conflit de date ; s'il en survenait un quand même, rien n'est écrit.
  const corrigerUneCible = (cible: Cible, correction: { valeur: number; validFrom: string }) => {
    const resultat = corrigerCible(cibles, cible.id, correction);
    if (resultat.conflit) {
      setErreurCible(MESSAGE_CONFLIT_CIBLE);
      return;
    }
    enregistrerCibles(resultat, "update", "Impossible de modifier la cible. Réessayez.");
  };
  // Remplacement confirmé par l'utilisateur : la cible prend la place de celle qui occupe la date.
  const remplacerUneCible = (cible: Cible, correction: { valeur: number; validFrom: string }) =>
    enregistrerCibles(remplacerCible(cibles, cible.id, correction), "replace", "Impossible de modifier la cible. Réessayez.");
  // Commentaire d'une version d'objectif : la ligne garde sa valeur et sa date d'effet.
  const commenterUneCible = (cible: Cible, saisie: string) =>
    enregistrerCibles(commenterCible(cibles, cible.id, saisie), "comment", "Le commentaire n'a pas pu être enregistré. Réessayez.");
  const retirerCible = (cible: Cible) =>
    enregistrerCibles(
      { cibles: cibles.filter((c) => c.id !== cible.id), operations: [{ type: "delete", id: cible.id }] },
      "delete",
      "Impossible de supprimer la cible. Réessayez."
    );
  const voirCibles = () => setVue("objectifs");

  const voirCategoriesAMapper = () => {
    setVue("mapping");
    setFiltreMapping("a_mapper");
  };

  const nombrePages = Math.max(1, Math.ceil(transactionsFiltrees.length / LIGNES_PAR_PAGE));
  const pageCourante = Math.min(page, nombrePages - 1);
  const lignesPage = transactionsFiltrees.slice(pageCourante * LIGNES_PAR_PAGE, (pageCourante + 1) * LIGNES_PAR_PAGE);

  const apresChangementDePeriode = () => {
    setPage(0);
    setSyncMessage(null);
    setSyncErreur(null);
  };

  const changerSelectionPeriode = (suivante: SelectionPeriode) => {
    choisirPeriode(suivante);
    apresChangementDePeriode();
  };

  const ouvrirReglageExercice = () => {
    setBrouillonExercice(configExercice);
    setJourExerciceRefuse(false);
    setErreurExercice(null);
    setReglageExerciceOuvert((ouvert) => !ouvert);
  };

  // Les presets se recalculent dès que l'exercice change ; une période personnalisée n'est pas touchée.
  const saisirExercice = (patch: { mois?: number; jour?: number | null }) => {
    const suivant = { ...brouillonExercice, ...patch };
    const refuse = suivant.jour !== null && suivant.jour > jourMaxDebutExercice(suivant.mois);
    setBrouillonExercice(refuse ? { ...suivant, jour: null } : suivant);
    setJourExerciceRefuse(refuse);
  };
  const exerciceSaisi: ConfigExercice | null =
    brouillonExercice.jour !== null && configExerciceValide({ mois: brouillonExercice.mois, jour: brouillonExercice.jour })
      ? { mois: brouillonExercice.mois, jour: brouillonExercice.jour }
      : null;

  const enregistrerExercice = async () => {
    if (!exerciceSaisi) return;
    setEnregistrementExercice(true);
    setErreurExercice(null);
    try {
      await sauvegarderExercice(supabase!, organizationId, exerciceSaisi);
      setExercice(exerciceSaisi);
      setReglageExerciceOuvert(false);
      apresChangementDePeriode();
    } catch (error) {
      const code = (error as { code?: string } | null)?.code ?? "inconnu";
      console.error(`[passe/exercice] step=save organization=${organizationId} code=${code}`);
      setErreurExercice("L'exercice n'a pas pu être enregistré. Réessayez.");
    } finally {
      setEnregistrementExercice(false);
    }
  };


  const basculerCategorie = (cle: string) => {
    setSelectionCategories(() => {
      const suivant = new Set(selectionEffective);
      if (suivant.has(cle)) suivant.delete(cle);
      else suivant.add(cle);
      return suivant;
    });
    setPage(0);
  };

  const choisirAxe = (groupId: string) => {
    if (!groupId) return;
    setAxeConfigure(groupId);
    setSelectionCategories(new Set());
    setPage(0);
    setErreurAxe(null);
    sauvegarderAxeConfigure(supabase!, organizationId, groupId).catch((error) => {
      console.error("Échec de l'enregistrement de l'axe analytique :", error);
      setErreurAxe("L'axe analytique n'a pas pu être enregistré. Il sera à choisir de nouveau.");
    });
  };

  const selecteurAxe = (id: string) => (
    <select id={id} value={axe.etat === "configure" ? (axe.axeId as string) : ""} onChange={(e) => choisirAxe(e.target.value)}>
      {axe.etat !== "configure" && <option value="">À choisir…</option>}
      {axes.map((a) => (
        <option key={a.groupId} value={a.groupId}>
          {libelleAxe(a, stockees)}
        </option>
      ))}
    </select>
  );

  const toutesLesCategories = () => {
    setSelectionCategories(new Set());
    setPage(0);
  };

  const libelleFiltre = () => {
    if (selectionEffective.size === 0) return "Toutes";
    if (selectionEffective.size === 1) {
      const [nom] = selectionEffective;
      return nom;
    }
    return `${selectionEffective.size} sélectionnées`;
  };

  const synchroniser = async () => {
    if (syncEnCours || !periodeOk) return;
    setSyncEnCours(true);
    setSyncMessage(null);
    setSyncErreur(null);
    try {
      const res = await fetch("/api/passe/sync", {
        method: "POST",
        headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
        body: JSON.stringify({ dateDebut: periode.debut, dateFin: periode.fin }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setSyncErreur(data.error || "La synchronisation Pennylane a échoué. Réessayez.");
        return;
      }
      const phrases = [
        `${pluriel(data.nombreSynchronisees ?? 0, "transaction synchronisée", "transactions synchronisées")} depuis Pennylane.`,
      ];
      if (data.complete === false) {
        phrases.push("Période très volumineuse : la synchronisation est peut-être incomplète, réduisez la période.");
      }
      if (data.libellesAxesDisponibles === false) {
        phrases.push(
          "Le token Pennylane ne permet pas de lire le nom des axes analytiques (autorisation « catégories » en lecture)."
        );
      }
      if (data.nouvellesCategories > 0) {
        phrases.push(`${pluriel(data.nouvellesCategories, "nouvelle catégorie", "nouvelles catégories")} à mapper.`);
      }
      setSyncMessage(phrases.join(" "));
      setRechargement((n) => n + 1);
    } catch {
      setSyncErreur("Pennylane est temporairement indisponible. Réessayez.");
    } finally {
      setSyncEnCours(false);
    }
  };

  // Avertissements de tête du rapport, sur les transactions de SA période (mêmes règles que l'écran).
  const avertissementsDuRapport = (lignes: PastTransactionStockee[], pnlTtc: ReturnType<typeof calculerPnl>, pnlBase: ReturnType<typeof calculerPnlEnBase>): string[] => {
    const avertissements: string[] = [];
    const nonCategorisees = compterNonCategorisees(appliquerAxe(lignes, axe.axeId));
    if (nonCategorisees > 0) {
      avertissements.push(`${pluriel(nonCategorisees, "transaction non catégorisée", "transactions non catégorisées")} sur la période, hors reporting.`);
    }
    if (pnlTtc.nonMappees.nombreCategories > 0) {
      avertissements.push(
        `Reporting incomplet : ${pluriel(pnlTtc.nonMappees.nombreCategories, "catégorie reste", "catégories restent")} à mapper (${formatMontantComptable(pnlTtc.nonMappees.montant)} exclus des calculs).`
      );
    }
    const signesInhabituels = compterTransactionsAvecAnomalie(repartirAnomalies(anomaliesDeSigne(lignes, axe.axeId, mappingsIndexes), validationsSigne).aVerifier);
    if (signesInhabituels > 0) {
      avertissements.push(`${pluriel(signesInhabituels, "transaction avec un signe inhabituel", "transactions avec un signe inhabituel")}, prises en compte telles quelles.`);
    }
    // Lecture HT : la couverture de la TVA est dite en tête, comme à l'écran.
    if (base === "ht" && pnlBase.couvertures && !pnlBase.couvertures.ebitda.complete) {
      avertissements.push(`Estimation incomplète : ${libelleCouverture(pnlBase.couvertures.ebitda).toLocaleLowerCase("fr")}`);
    }
    return avertissements;
  };

  // Export PDF : le rapport de la période choisie à l'export. Les transactions sont relues pour CETTE
  // période (et pour la période comparée), les factures pour le BFR : rien ne dépend de la période
  // ou des sélecteurs affichés à l'écran. Calculs : ceux des écrans, jamais réécrits ici.
  const exportPossible = !chargement && !erreurChargement && !axeAConfigurer;
  const moisExport = useMemo(() => moisProposes(premiereDate ?? null, aujourdhui), [premiereDate, aujourdhui]);
  const exercicesExport = useMemo(() => exercicesProposes(premiereDate ?? null, aujourdhui, configExercice), [premiereDate, aujourdhui, configExercice]);
  // Choix effectif : toujours l'une des périodes proposées.
  const choixEffectif: ChoixRapport =
    choixExport.type === "mois"
      ? { type: "mois", mois: moisExport.includes(choixExport.mois) ? choixExport.mois : moisExport[0] }
      : { type: "exercice", debut: exercicesExport.some((e) => e.debut === choixExport.debut) ? choixExport.debut : exercicesExport[0].debut };
  const planExport = planRapport(choixEffectif, aujourdhui, configExercice);

  const ouvrirExport = () => {
    setExportErreur(null);
    setExportOuvert((ouvert) => !ouvert);
    if (premiereDate !== undefined) return;
    chargerPremiereDateTransaction(supabase!, organizationId)
      .then(setPremiereDate)
      .catch((error) => {
        const code = (error as { code?: string } | null)?.code ?? "inconnu";
        console.error(`[passe/export] step=load-first-date organization=${organizationId} code=${code}`);
        setPremiereDate(null);
      });
  };

  const exporterPdf = async (plan: PlanRapport) => {
    if (exportEnCours || !exportPossible) return;
    setExportEnCours(true);
    setExportErreur(null);
    try {
      const [lignesRapport, lignesA, faitsBfr, validees] = await Promise.all([
        chargerPastTransactions(supabase!, organizationId, plan.periode),
        chargerPastTransactions(supabase!, organizationId, plan.ecarts.a),
        chargerFacturesBfr(supabase!, organizationId),
        chargerSituationsValidees(supabase!, organizationId),
      ]);
      // B est toujours contenue dans la période du rapport (entière, ou à date) : pas de second chargement.
      const lignesB = lignesRapport.filter((t) => t.transactionDate >= plan.ecarts.b.debut && t.transactionDate <= plan.ecarts.b.fin);

      const ajustementsRapport = ajustementsDeLaPeriode(tousLesAjustements, plan.periode);
      const pnlTtc = calculerPnl(lignesRapport, axe.axeId, mappingsIndexes, ajustementsRapport);
      const pnlBase = calculerPnlEnBase(lignesRapport, axe.axeId, mappingsIndexes, ajustementsRapport, base);
      const partsTtc = partsMappees(lignesRapport, axe.axeId, mappingsIndexes);
      // L'export suit la lecture affichée ; le Cash flow reste sur les parts TTC, le BFR en HT.
      const pagesPnl = pagesExportPdf({
        pnl: pnlBase,
        parts: partsEnBase(partsTtc, tauxParCategorie(mappingsIndexes), base),
        partsTtc,
        base,
        periode: plan.periode,
        ajustements: ajustementsRapport,
        avertissements: avertissementsDuRapport(lignesRapport, pnlTtc, pnlBase),
        ongletOuvert: "general",
        filtresOngletOuvert: { categorie: null, mois: null },
        entete: entetePnl(plan, aujourdhui),
      });
      const synchroniseLe = faitsBfr.synchroniseesLe ? toISODate(new Date(faitsBfr.synchroniseesLe)) : null;
      const pageBfr = pageBfrPdf(plan, { factures: faitsBfr.factures, validees, stocks, sansStock, synchroniseLe }, aujourdhui);
      const pageEcarts = pageEcartsPdf({
        plan: plan.ecarts,
        transactionsA: lignesA,
        transactionsB: lignesB,
        axeId: axe.axeId,
        mappings: mappingsIndexes,
        ajustements: tousLesAjustements,
        financementCompris: ecartsFinancementCompris,
      });
      const { genererPdfPasse, telechargerPdf } = await import("@/lib/pastPdfDocument");
      const blob = await genererPdfPasse({ organisation: organizationName, pages: [...pagesPnl, pageBfr, pageEcarts], teintes: teintesParCategorie(pnlTtc.categories) });
      telechargerPdf(blob, nomFichierPdf(organizationName, plan.periode));
      setExportOuvert(false);
    } catch (error) {
      console.error("Échec de l'export PDF du module Passé :", error);
      setExportErreur("Le PDF n'a pas pu être généré. Réessayez.");
    } finally {
      setExportEnCours(false);
    }
  };

  return (
    <section className="passe">
      <div className="passe-controles">
        <div className="passe-controle passe-axe">
          {/* L'onglet Écarts compare deux périodes qui lui sont propres : la période du module n'y
              joue pas, elle est masquée pour ne pas laisser croire le contraire. */}
          {(vue === "general" || estMetriqueDetail(vue)) && <PasseSelecteurBase base={base} onChange={choisirBase} />}
          {vue !== "ecarts" && (
            <PasseSelecteurPeriode
              id="passe-periode-preset"
              libelle="Période"
              selection={selectionCourante}
              onChange={changerSelectionPeriode}
              aujourdhui={aujourdhui}
              configExercice={configExercice}
            />
          )}

          <div className="passe-filtre" ref={reglageExerciceRef}>
            <button
              type="button"
              className="btn-secondaire"
              aria-haspopup="true"
              aria-expanded={reglageExerciceOuvert}
              onClick={ouvrirReglageExercice}
            >
              Paramétrer l&apos;exercice
            </button>
            {reglageExerciceOuvert && (
              <div className="passe-filtre__popover passe-exercice">
                <span className="passe-controle__label">Début de l&apos;exercice</span>
                <div className="passe-exercice__champs">
                  <select
                    aria-label="Jour de début de l'exercice"
                    value={brouillonExercice.jour ?? ""}
                    onChange={(e) => saisirExercice({ jour: e.target.value === "" ? null : Number(e.target.value) })}
                  >
                    <option value="">Jour</option>
                    {Array.from({ length: 31 }, (_, i) => i + 1).map((jour) => (
                      <option key={jour} value={jour}>
                        {String(jour).padStart(2, "0")}
                      </option>
                    ))}
                  </select>
                  <select
                    aria-label="Mois de début de l'exercice"
                    value={brouillonExercice.mois}
                    onChange={(e) => saisirExercice({ mois: Number(e.target.value) })}
                  >
                    {Array.from({ length: 12 }, (_, i) => i + 1).map((mois) => (
                      <option key={mois} value={mois}>
                        {nomMoisExercice(mois)}
                      </option>
                    ))}
                  </select>
                </div>
                {jourExerciceRefuse ? (
                  <p className="login-erreur">
                    Cette date n&apos;existe pas chaque année en {nomMoisExercice(brouillonExercice.mois)}. Choisissez un
                    autre jour.
                  </p>
                ) : (
                  exerciceSaisi && <p className="passe-message">{descriptionExercice(exerciceSaisi)}</p>
                )}
                {erreurExercice && <p className="login-erreur">{erreurExercice}</p>}
                <button type="button" className="btn-add" onClick={enregistrerExercice} disabled={enregistrementExercice || !exerciceSaisi}>
                  {enregistrementExercice ? "Enregistrement…" : "Enregistrer"}
                </button>
              </div>
            )}
          </div>
        </div>

        {vue === "transactions" && (
        <div className="passe-controle passe-filtre" ref={filtreRef}>
          <span className="passe-controle__label">Catégories</span>
          <button
            type="button"
            className="btn-secondaire passe-filtre__bouton"
            aria-haspopup="true"
            aria-expanded={filtreOuvert}
            onClick={() => setFiltreOuvert((o) => !o)}
            disabled={axeAConfigurer}
          >
            {libelleFiltre()} <span aria-hidden="true">▾</span>
          </button>
          {filtreOuvert && (
            <div className="passe-filtre__popover">
              <label className="passe-filtre__option">
                <input type="checkbox" checked={selectionEffective.size === 0} onChange={toutesLesCategories} />
                Toutes les catégories
              </label>
              <hr />
              {categories.map((nom) => (
                <label key={nom} className="passe-filtre__option">
                  <input type="checkbox" checked={selectionEffective.has(nom)} onChange={() => basculerCategorie(nom)} />
                  {nom}
                </label>
              ))}
            </div>
          )}
        </div>
        )}

        {axes.length > 1 && !axeAConfigurer && (
          <div className="passe-controle passe-axe">
            <label className="passe-controle__label" htmlFor="passe-axe-select">
              Axe analytique
            </label>
            {selecteurAxe("passe-axe-select")}
          </div>
        )}

        <div className="passe-controles__actions">
          <div className="passe-filtre" ref={exportRef}>
            <button
              type="button"
              className="btn-secondaire"
              aria-haspopup="true"
              aria-expanded={exportOuvert}
              onClick={ouvrirExport}
              disabled={exportEnCours || !exportPossible}
            >
              {exportEnCours ? "Génération du PDF…" : "Exporter en PDF"}
            </button>
            {exportOuvert && (
              <div className="passe-filtre__popover passe-export" role="dialog" aria-label="Période du rapport PDF">
                <span className="passe-controle__label">Période du rapport</span>
                <div className="passe-tri selecteur" role="group" aria-label="Type de période">
                  {(["mois", "exercice"] as const).map((type) => (
                    <button
                      key={type}
                      type="button"
                      className={`btn-secondaire${choixEffectif.type === type ? " btn-module--actif" : ""}`}
                      aria-pressed={choixEffectif.type === type}
                      onClick={() =>
                        setChoixExport(type === "mois" ? { type, mois: dernierMoisTermine(aujourdhui) } : { type, debut: exercicesExport[0].debut })
                      }
                    >
                      {type === "mois" ? "Mois" : "Exercice"}
                    </button>
                  ))}
                </div>
                {premiereDate === undefined ? (
                  <p className="passe-message">Chargement des périodes disponibles…</p>
                ) : choixEffectif.type === "mois" ? (
                  <select aria-label="Mois du rapport" value={choixEffectif.mois} onChange={(e) => setChoixExport({ type: "mois", mois: e.target.value })}>
                    {moisExport.map((m) => (
                      <option key={m} value={m}>
                        {libelleMois(m)}
                        {m === aujourdhui.slice(0, 7) ? " (en cours)" : ""}
                      </option>
                    ))}
                  </select>
                ) : (
                  <select aria-label="Exercice du rapport" value={choixEffectif.debut} onChange={(e) => setChoixExport({ type: "exercice", debut: e.target.value })}>
                    {exercicesExport.map((e) => (
                      <option key={e.debut} value={e.debut}>
                        {libelleExercice(e)} · {formatDateCourte(e.debut)} → {formatDateCourte(e.fin)}
                        {e.fin >= aujourdhui ? " (en cours)" : ""}
                      </option>
                    ))}
                  </select>
                )}
                <span className="passe-controle__label">Le rapport contiendra</span>
                <ul className="passe-export__resume">
                  {resumeDuPlan(planExport).map((ligne) => (
                    <li key={ligne}>{ligne}</li>
                  ))}
                </ul>
                <p className="passe-message">
                  Montants du P&amp;L en {base === "ht" ? MENTION_HT_ESTIME : MENTION_TTC} (Cash flow en {MENTION_TTC}) · BFR toujours HT · Analyse
                  d&apos;écarts en {MENTION_TTC}, {ecartsFinancementCompris ? "financement compris" : "hors financement"}. Stocks, Objectifs et Correspondance
                  P&amp;L ne sont pas exportés.
                </p>
                <button type="button" className="btn-add" onClick={() => exporterPdf(planExport)} disabled={exportEnCours || premiereDate === undefined}>
                  {exportEnCours ? "Génération du PDF…" : "Générer le PDF"}
                </button>
                {exportErreur && <p className="login-erreur">{exportErreur}</p>}
              </div>
            )}
          </div>
          {pennylaneConnecte === true && (
            <button type="button" className="btn-add" onClick={synchroniser} disabled={syncEnCours || !periodeOk}>
              {syncEnCours ? "Synchronisation…" : "Synchroniser Pennylane"}
            </button>
          )}
          {pennylaneConnecte === false && (
            <button type="button" className="btn-secondaire" onClick={() => router.push("/account/integrations")}>
              Connecter Pennylane
            </button>
          )}
        </div>
      </div>

      {exportErreur && <p className="login-erreur">{exportErreur}</p>}
      {syncErreur && <p className="login-erreur">{syncErreur}</p>}
      {syncMessage && <p className="passe-message">{syncMessage}</p>}
      {erreurAxe && <p className="login-erreur">{erreurAxe}</p>}
      {erreurMapping && <p className="login-erreur">{erreurMapping}</p>}
      {erreurStock && <p className="login-erreur">{erreurStock}</p>}

      <div className="passe-onglets" role="tablist">
        {[false, true].map((actions) => (
          <div key={String(actions)} className="passe-onglets__groupe" role="presentation">
            {ONGLETS.filter((onglet) => !("horsNavigation" in onglet) && "actions" in onglet === actions).map((onglet) => {
              const verrouille = vueVerrouillee(onglet.cle, droits);
              const restriction = CAPACITE_PAR_VUE[onglet.cle];
              return (
                <button
                  key={onglet.cle}
                  type="button"
                  role="tab"
                  aria-selected={vue === onglet.cle}
                  className={`passe-onglet${vue === onglet.cle ? " passe-onglet--actif" : ""}${
                    verrouille ? " passe-onglet--verrouille" : "vedette" in onglet ? " passe-onglet--vedette" : ""
                  }`}
                  title={verrouille && restriction ? messageOffreRequise(restriction.capacite) : undefined}
                  onClick={() => setVue(onglet.cle)}
                >
                  {verrouille && <IconCadenas />}
                  {onglet.libelle}
                  {onglet.cle === "mapping" && nombreAMapper > 0 && (
                    <span className="passe-onglet__pastille">{nombreAMapper}</span>
                  )}
                </button>
              );
            })}
          </div>
        ))}
      </div>

      {!periodeOk ? (
        <p className="login-erreur">
          La date de début doit précéder la date de fin.
        </p>
      ) : erreurChargement ? (
        <div className="passe-etat">
          <p>{erreurChargement}</p>
          <button type="button" className="btn-secondaire" onClick={() => setRechargement((n) => n + 1)}>
            Réessayer
          </button>
        </div>
      ) : chargement ? (
        <div className="passe-etat">Chargement des transactions…</div>
      ) : (
        <>
          {axeAConfigurer ? (
            <div className="passe-axe-a-configurer passe-axe">
              <p>
                <strong>Axe analytique à configurer.</strong> Vos transactions sont catégorisées selon plusieurs axes
                analytiques. Choisissez celui que le module Passé doit utiliser ; aucune transaction n&apos;est listée
                tant que ce choix n&apos;est pas fait.
              </p>
              {selecteurAxe("passe-axe-a-configurer-select")}
            </div>
          ) : vue === "ecarts" || vue === "bfr" ? null : (
            <div className="passe-indicateurs">
              <p className={`passe-non-categorise${nombreNonCategorisees > 0 ? " passe-non-categorise--alerte" : ""}`}>
                {nombreNonCategorisees > 0 && <span aria-hidden="true">⚠ </span>}
                {nombreNonCategorisees === 0
                  ? "Aucune transaction non catégorisée sur la période"
                  : `${pluriel(nombreNonCategorisees, "transaction non catégorisée", "transactions non catégorisées")}${
                      nonCategoriseesToutesPennylane ? " dans Pennylane" : ""
                    }`}
              </p>
              {/* Notion distincte de la précédente : ici la catégorie existe, il lui manque un étage P&L. */}
              {nombreAMapper === 0 ? (
                <p className="passe-non-categorise">Aucune catégorie à mapper</p>
              ) : (
                <button type="button" className="btn-secondaire" onClick={voirCategoriesAMapper}>
                  {pluriel(nombreAMapper, "catégorie à mapper", "catégories à mapper")} →
                </button>
              )}
              {/* Autre famille que les indicateurs de transactions : ce que l'utilisateur renseigne
                  lui-même. Même alerte que « non catégorisée », mais cliquable : elle mène à la saisie. */}
              {donneesACompleter.map((donnee) => (
                <button
                  key={donnee.type}
                  type="button"
                  className="passe-non-categorise passe-non-categorise--alerte passe-donnee-gestion"
                  title={donnee.detail}
                  onClick={() => setVue(donnee.onglet)}
                >
                  <span aria-hidden="true">⚠ </span>
                  Données de gestion : {donnee.libelle.charAt(0).toLowerCase()}
                  {donnee.libelle.slice(1)} →
                </button>
              ))}
              {(nombreSignesInhabituels > 0 || nombreSignesValides > 0) && (
                <button
                  type="button"
                  className="btn-secondaire"
                  aria-expanded={detailSignesOuvert}
                  onClick={() => setDetailSignesOuvert((o) => !o)}
                >
                  {nombreSignesInhabituels > 0
                    ? pluriel(nombreSignesInhabituels, "transaction avec un signe inhabituel", "transactions avec un signe inhabituel")
                    : `Signes inhabituels : ${pluriel(nombreSignesValides, "transaction validée", "transactions validées")}`}{" "}
                  <span aria-hidden="true">{detailSignesOuvert ? "▴" : "▾"}</span>
                </button>
              )}
            </div>
          )}

          {!axeAConfigurer && vue !== "ecarts" && vue !== "bfr" && detailSignesOuvert && (nombreSignesInhabituels > 0 || nombreSignesValides > 0) && (
            <div className="passe-signes-detail">
              <div className="passe-tri" role="group" aria-label="Signes inhabituels à afficher">
                <span className="selecteur">
                  <button
                    type="button"
                    className={`btn-secondaire${vueSignes === "a_verifier" ? " btn-module--actif" : ""}`}
                    aria-pressed={vueSignes === "a_verifier"}
                    onClick={() => setVueSignes("a_verifier")}
                  >
                    À vérifier <span className="passe-detail__compte">{signes.aVerifier.length}</span>
                  </button>
                  <button
                    type="button"
                    className={`btn-secondaire${vueSignes === "validees" ? " btn-module--actif" : ""}`}
                    aria-pressed={vueSignes === "validees"}
                    onClick={() => setVueSignes("validees")}
                  >
                    Validées <span className="passe-detail__compte">{signes.validees.length}</span>
                  </button>
                </span>
                {/* Retour discret après une action ; s'efface seul. */}
                <span className="passe-signes-detail__retour" role="status">
                  {messageSigne}
                </span>
              </div>
              {erreurSigne && <p className="login-erreur">{erreurSigne}</p>}
              <p className="passe-message">
                {vueSignes === "a_verifier"
                  ? "À vérifier, sans urgence : un signe inhabituel peut être légitime (remboursement client, avoir fournisseur, correction bancaire). « C'est OK » retire la ligne de cette liste ; le montant reste pris en compte tel quel dans le reporting."
                  : "Transactions que vous avez vérifiées et jugées normales. Elles restent comptées telles quelles dans le reporting."}
              </p>
              {(vueSignes === "a_verifier" ? signes.aVerifier : signes.validees).length === 0 ? (
                <p className="passe-structure__vide">
                  {vueSignes === "a_verifier" ? "Aucune transaction à vérifier sur la période." : "Aucune transaction validée sur la période."}
                </p>
              ) : (
                <div className="table-wrapper">
                  <table className="passe-table">
                    <thead>
                      <tr>
                        <th>Date</th>
                        <th>Libellé</th>
                        <th className="col-montant">
                          Montant
                          <MentionTTC />
                        </th>
                        <th>Catégorie</th>
                        <th>Étage P&amp;L</th>
                        <th>Anomalie</th>
                        {vueSignes === "validees" && <th>Validée le</th>}
                        <th>
                          <span className="passe-visuellement-cache">Action</span>
                        </th>
                      </tr>
                    </thead>
                    <tbody>
                      {vueSignes === "a_verifier"
                        ? signes.aVerifier.map((a) => (
                            <tr key={`${a.transactionId}:${a.sourceCategoryId}`}>
                              <td className="passe-table__date">{formatDateCourte(a.transactionDate)}</td>
                              <td className="passe-table__libelle">{a.label || "—"}</td>
                              <td className="col-montant passe-table__montant">{formatMontant(a.montant)}</td>
                              <td>{a.sourceCategoryName}</td>
                              <td>{libelleEtagePnl(a.etage)}</td>
                              <td>
                                <span className="passe-statut">{LIBELLES_ANOMALIE_SIGNE[a.type]}</span>
                              </td>
                              <td className="passe-signes-detail__action">
                                <button type="button" className="btn-secondaire" onClick={() => validerAnomalie(a)}>
                                  C&apos;est OK
                                </button>
                              </td>
                            </tr>
                          ))
                        : signes.validees.map((a) => (
                            <tr key={`${a.transactionId}:${a.sourceCategoryId}`}>
                              <td className="passe-table__date">{formatDateCourte(a.transactionDate)}</td>
                              <td className="passe-table__libelle">{a.label || "—"}</td>
                              <td className="col-montant passe-table__montant">{formatMontant(a.montant)}</td>
                              <td>{a.sourceCategoryName}</td>
                              <td>{libelleEtagePnl(a.etage)}</td>
                              <td>
                                <span className="passe-statut">{LIBELLES_ANOMALIE_SIGNE[a.type]}</span>
                              </td>
                              <td className="passe-table__date">{formatDateCourte(toISODate(new Date(a.validatedAt)))}</td>
                              <td className="passe-signes-detail__action">
                                <button type="button" className="btn-secondaire" onClick={() => annulerValidation(a)}>
                                  Annuler la validation
                                </button>
                              </td>
                            </tr>
                          ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          )}

          {!axeAConfigurer && vue !== "mapping" && vue !== "objectifs" && vue !== "transactions" && vue !== "stocks" && vue !== "ecarts" && vue !== "bfr" && pnl.nonMappees.nombreCategories > 0 && (
            <p className="passe-message">
              Reporting incomplet :{" "}
              {pnl.nonMappees.nombreCategories > 1
                ? `${pnl.nonMappees.nombreCategories} catégories utilisées sur la période restent à mapper`
                : "1 catégorie utilisée sur la période reste à mapper"}{" "}
              ({formatMontantComptable(pnl.nonMappees.montant)} exclus des calculs).
            </p>
          )}

          {axeAConfigurer ? null : vue === "general" ? (
            <PasseGeneral
              pnl={pnlAffiche}
              teintes={teintesCategories}
              cibles={ecartsCibles}
              onOuvrir={setVue}
              onDefinirCible={voirCibles}
              onConfigurerTva={() => setVue("mapping")}
            />
          ) : estMetriqueDetail(vue) ? (
            // `key` : changer d'onglet remonte l'écran, donc réinitialise ses filtres locaux
            // (catégorie, mois) ; la période, elle, vit ici et reste inchangée.
            <PastDetailDashboard
              key={vue}
              metrique={vue}
              // Cash flow : flux bancaires réels, toujours sur les parts TTC.
              parts={vue === "cash_flow" ? partsDetail : partsDetailAffichees}
              base={vue === "cash_flow" ? "ttc" : base}
              onConfigurerTva={() => setVue("mapping")}
              periode={periode}
              ajustements={ajustements}
              teintes={teintesCategories}
              // Objectifs exclusivement HT : aucune cible en lecture TTC, ni sur le Cash flow.
              cibles={base === "ht" && vue !== "cash_flow" ? cibles : undefined}
            />
          ) : vueVerrouillee(vue, droits) && CAPACITE_PAR_VUE[vue] ? (
            // Jamais monté hors offre : l'écran verrouillé remplace le composant, qui n'appelle donc
            // aucune route (la route BFR refuse de toute façon, voir app/api/passe/bfr).
            <OffreVerrouillee
              capacite={CAPACITE_PAR_VUE[vue].capacite}
              fonctionnalite={CAPACITE_PAR_VUE[vue].fonctionnalite}
              offreActuelle={droits.offreEffective}
            />
          ) : vue === "recurrence" ? (
            <PasseRecurrence
              recurrence={recurrence}
              mention={base === "ht" ? MENTION_HT_ESTIME : MENTION_TTC}
              parametrageIndisponible={!natureDisponible}
              onClasser={voirCategoriesAMapper}
            />
          ) : vue === "ecarts" ? (
            <>
            {base === "ht" && <p className="passe-message">{LIBELLE_ECARTS_EN_TTC}</p>}
            <PasseEcarts
              organizationId={organizationId}
              axeId={axe.axeId}
              mappings={mappingsIndexes}
              ajustements={tousLesAjustements}
              aujourdhui={aujourdhui}
              configExercice={configExercice}
              selections={selectionsEcartsCourantes}
              financementCompris={ecartsFinancementCompris}
              onChangeFinancementCompris={setEcartsFinancementCompris}
              onChangeSelections={setSelectionsEcarts}
              rechargement={rechargement}
            />
            </>
          ) : vue === "bfr" ? (
            <PasseBfr
              organizationId={organizationId}
              accessToken={accessToken}
              mois={moisTerminesDeLaPeriode(periode, aujourdhui)}
              stocks={stocks}
              sansStock={sansStock}
              pennylaneConnecte={pennylaneConnecte}
              onOuvrirStocks={() => setVue("stocks")}
            />
          ) : vue === "stocks" ? (
            <PasseStocks
              mois={moisDeLaPeriode(periode)}
              stocks={stocks}
              sansStock={sansStock}
              onDeclarerSansStock={declarerSansStock}
              onEnregistrer={enregistrerStock}
              onSupprimer={retirerStock}
            />
          ) : vue === "objectifs" ? (
            <PasseObjectifs
              key={periode.debut}
              cibles={cibles}
              categoriesCa={lignesCorrespondance.filter((l) => l.pnlStage === "revenue").map((l) => ({ id: l.sourceCategoryId, nom: l.sourceCategoryName }))}
              dateParDefaut={periode.debut}
              erreur={erreurCible}
              onPoser={poserUneCible}
              onCorriger={corrigerUneCible}
              onRemplacer={remplacerUneCible}
              onCommenter={commenterUneCible}
              onSupprimer={retirerCible}
            />
          ) : vue === "mapping" ? (
            <PasseMappingTable
              lignes={lignesCorrespondance}
              filtre={filtreMapping}
              onChangeFiltre={setFiltreMapping}
              onChangeDestination={changerDestination}
              onChangeTva={changerTauxTva}
              natureActive={natureActive}
            />
          ) : transactions.length === 0 ? (
            <div className="passe-etat">
              <p>Aucune transaction sur cette période.</p>
              {pennylaneConnecte === true && <p>Synchronisez Pennylane pour récupérer vos transactions.</p>}
            </div>
          ) : categorisees.length === 0 ? (
            <div className="passe-etat">Aucune transaction catégorisée sur cette période.</div>
          ) : transactionsFiltrees.length === 0 ? (
            <div className="passe-etat">Aucune transaction ne correspond aux catégories sélectionnées.</div>
          ) : (
            <>
              <div className="table-wrapper">
                <table className="passe-table">
                  <thead>
                    <tr>
                      <th>Date</th>
                      <th>Libellé</th>
                      <th className="col-montant">Montant</th>
                      <th>Catégorie analytique</th>
                    </tr>
                  </thead>
                  <tbody>
                    {lignesPage.map((t) => (
                      <tr key={t.id}>
                        <td className="passe-table__date">{formatDateCourte(t.transactionDate)}</td>
                        <td className="passe-table__libelle">{t.label || "—"}</td>
                        <td className="col-montant passe-table__montant">{formatMontant(t.amount)}</td>
                        <td>{t.analyticCategoryName}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <div className="passe-pagination">
                <span>
                  {pluriel(transactionsFiltrees.length, "transaction", "transactions")}
                  {selectionEffective.size > 0 && ` sur ${formatNombre.format(categorisees.length)}`}
                </span>
                {nombrePages > 1 && (
                  <div className="passe-pagination__actions">
                    <button
                      type="button"
                      className="btn-secondaire"
                      onClick={() => setPage(pageCourante - 1)}
                      disabled={pageCourante === 0}
                    >
                      ← Précédent
                    </button>
                    <span>
                      Page {pageCourante + 1} / {nombrePages}
                    </span>
                    <button
                      type="button"
                      className="btn-secondaire"
                      onClick={() => setPage(pageCourante + 1)}
                      disabled={pageCourante >= nombrePages - 1}
                    >
                      Suivant →
                    </button>
                  </div>
                )}
              </div>
            </>
          )}
        </>
      )}
      <Cartouche
        titre="Passé"
        lignes={[
          { libelle: "Société", valeur: organizationName || "—" },
          { libelle: "Période", valeur: `${formatDateCourte(periode.debut)} → ${formatDateCourte(periode.fin)}` },
          { libelle: "Lecture", valeur: base === "ht" ? MENTION_HT_ESTIME : MENTION_TTC },
          { libelle: "Édité le", valeur: formatDateCourte(aujourdhui) },
        ]}
      />
      {/* Rappel permanent, commun à tous les onglets du module, selon la lecture choisie. */}
      {vue === "bfr" && vueVerrouillee(vue, droits) ? null : vue === "bfr" ? (
        <p className="passe-disclaimer">
          BFR toujours en HT : montants HT des factures Pennylane réelles et stocks saisis HT. Aucun taux de TVA appliqué,
          aucune facture prévisionnelle.
        </p>
      ) : base === "ttc" ? (
        <p className="passe-disclaimer">{DISCLAIMER_PASSE}</p>
      ) : (
        <p className="passe-disclaimer">
          {DISCLAIMER_HT_ESTIME} {PRECISION_HT_ESTIME}
          {pnlAffiche.couvertures && !pnlAffiche.couvertures.ebitda.complete
            ? ` Estimation incomplète sur la période : ${libelleCouverture(pnlAffiche.couvertures.ebitda).toLocaleLowerCase("fr")}`
            : ""}
        </p>
      )}
    </section>
  );
}
