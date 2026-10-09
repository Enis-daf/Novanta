"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import DateField from "./DateField";
import PasseGeneral from "./PasseGeneral";
import PasseMappingTable from "./PasseMappingTable";
import PasseStocks from "./PasseStocks";
import PastDetailDashboard from "./PastDetailDashboard";
import { supabase } from "@/lib/supabaseClient";
import { formatDateCourte, todayISO, toISODate } from "@/lib/dates";
import {
  ChoixPeriode,
  cleStockagePeriode,
  ConfigExercice,
  descriptionExercice,
  deserialiserSelection,
  EXERCICE_PAR_DEFAUT,
  configExerciceValide,
  GROUPES_PRESETS,
  jourMaxDebutExercice,
  nomMoisExercice,
  periodeDeLaSelection,
  periodeDuPreset,
  presetCorrespondant,
  PRESETS_PERIODE,
  SelectionPeriode,
  selectionParDefaut,
  serialiserSelection,
} from "@/lib/fiscalPeriods";
import { formatMontant, formatMontantComptable } from "@/lib/format";
import { teintesParCategorie } from "@/lib/dataviz";
import {
  AjustementGestion,
  ajustementsDeLaPeriode,
  ajustementsDepuisStocks,
  StockFinDeMois,
} from "@/lib/pastAdjustments";
import { estMetriqueDetail, FiltresDetail, moisDeLaPeriode, partsMappees } from "@/lib/pastDetail";
import { nomFichierPdf, pagesExportPdf } from "@/lib/pastPdfModel";
import { calculerPnl } from "@/lib/pastPnl";
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
  EtagePnl,
  FiltreMapping,
  libelleEtagePnl,
  indexerMappings,
  lignesMapping,
  MappingCategorie,
} from "@/lib/pastCategoryMapping";
import {
  annulerValidationSigne,
  chargerAxeConfigure,
  chargerAjustementsGestion,
  chargerAxesAnalytiques,
  chargerExercice,
  chargerMappingsCategories,
  chargerStocks,
  chargerPastTransactions,
  chargerValidationsSigne,
  sauvegarderAxeConfigure,
  sauvegarderEtageCategorie,
  sauvegarderExercice,
  sauvegarderStock,
  supprimerStock,
  validerSigne,
} from "@/lib/pastTransactionsRepository";

interface PasseTransactionsProps {
  organizationId: string;
  // Nom affiché en tête de l'export PDF et repris dans le nom du fichier.
  organizationName: string;
  accessToken: string;
}

const LIGNES_PAR_PAGE = 50;

// Onglets du module Passé. La période, choisie une fois, s'applique à tous.
const ONGLETS = [
  { cle: "general", libelle: "Général" },
  { cle: "ca", libelle: "CA" },
  { cle: "marge_brute", libelle: "Marge brute" },
  { cle: "marge_contributive", libelle: "Marge contributive" },
  { cle: "ebitda", libelle: "EBITDA" },
  { cle: "cash_flow", libelle: "Cash flow" },
  { cle: "stocks", libelle: "Stocks" },
  { cle: "mapping", libelle: "Correspondance P&L" },
  // Plus proposé dans la navigation : une liste brute de transactions, sans contexte, n'explique
  // aucun chiffre. Les transactions se consultent dans les écrans de détail, par étage, catégorie
  // et mois. La vue reste définie (rien d'autre n'est retiré) mais n'est plus atteignable.
  { cle: "transactions", libelle: "Transactions", horsNavigation: true },
] as const;

type Vue = (typeof ONGLETS)[number]["cle"];
const formatNombre = new Intl.NumberFormat("fr-FR");

function pluriel(nombre: number, singulier: string, plurielTexte: string): string {
  return `${formatNombre.format(nombre)} ${nombre > 1 ? plurielTexte : singulier}`;
}

// Tableau des transactions du module Passé. Lit uniquement past_transactions (jamais Pennylane
// directement) : la source d'une transaction n'a aucune incidence sur l'affichage.
export default function PasseTransactions({ organizationId, organizationName, accessToken }: PasseTransactionsProps) {
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
  const [filtreMapping, setFiltreMapping] = useState<FiltreMapping>("toutes");
  const [erreurMapping, setErreurMapping] = useState<string | null>(null);
  const [detailSignesOuvert, setDetailSignesOuvert] = useState(false);
  // Anomalies de signe que l'utilisateur a vérifiées et acceptées (en base, par organisation).
  const [validationsSigne, setValidationsSigne] = useState<ValidationSigne[]>([]);
  const [vueSignes, setVueSignes] = useState<"a_verifier" | "validees">("a_verifier");
  const [messageSigne, setMessageSigne] = useState<string | null>(null);
  const [erreurSigne, setErreurSigne] = useState<string | null>(null);
  // Ajustements de gestion : ceux saisis tels quels, et les stocks de fin de mois dont dérive la
  // variation de stock. Les deux séries sont chargées entières (indépendantes de la période).
  const [ajustementsSaisis, setAjustementsSaisis] = useState<AjustementGestion[]>([]);
  const [stocks, setStocks] = useState<StockFinDeMois[]>([]);
  const [erreurStock, setErreurStock] = useState<string | null>(null);
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
  // Export PDF. Les filtres locaux de l'écran de détail affiché sont seulement LUS ici (une
  // référence, pas un état) : ils restent propres à cet écran et se réinitialisent avec lui.
  const [exportEnCours, setExportEnCours] = useState(false);
  const [exportErreur, setExportErreur] = useState<string | null>(null);
  const filtresOngletOuvert = useRef<FiltresDetail>({ categorie: null, mois: null });
  const retenirFiltresOnglet = useCallback((filtres: FiltresDetail) => {
    filtresOngletOuvert.current = filtres;
  }, []);

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
  const lignesCorrespondance = useMemo(
    () => lignesMapping(mappings, axe.axeId, stockees),
    [mappings, axe.axeId, stockees]
  );
  const nombreAMapper = useMemo(() => compterAMapper(lignesCorrespondance), [lignesCorrespondance]);

  // P&L de la période : transaction -> catégories pondérées -> mapping courant -> étage. Recalculé
  // dès qu'un mapping change, sans relire ni réécrire les transactions.
  const mappingsIndexes = useMemo(() => indexerMappings(mappings), [mappings]);
  // Ajustements de gestion de la période, toutes natures confondues : ceux saisis tels quels et
  // les variations de stock, calculées à partir de la série entière des stocks.
  const ajustements = useMemo(
    () => ajustementsDeLaPeriode([...ajustementsSaisis, ...ajustementsDepuisStocks(stocks)], periode),
    [ajustementsSaisis, stocks, periode]
  );
  const pnl = useMemo(
    () => calculerPnl(stockees, axe.axeId, mappingsIndexes, ajustements),
    [stockees, axe.axeId, mappingsIndexes, ajustements]
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

  const changerEtage = (sourceCategoryId: string, etage: EtagePnl) => {
    const precedent = mappings.find((m) => m.sourceCategoryId === sourceCategoryId)?.pnlStage ?? null;
    if (precedent === etage) return;
    const appliquer = (valeur: EtagePnl | null) =>
      setMappings((prev) => prev.map((m) => (m.sourceCategoryId === sourceCategoryId ? { ...m, pnlStage: valeur } : m)));
    appliquer(etage);
    setErreurMapping(null);
    sauvegarderEtageCategorie(supabase!, organizationId, sourceCategoryId, etage).catch((error) => {
      const code = (error as { code?: string } | null)?.code ?? "inconnu";
      console.error(
        `[passe/mapping] step=update_pnl_stage organization=${organizationId} category=${sourceCategoryId} code=${code}`
      );
      appliquer(precedent);
      setErreurMapping("Le mapping n'a pas pu être enregistré. Réessayez.");
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

  // Saisie libre d'une date : la sélection devient « Personnalisé », sauf si les dates tombent
  // EXACTEMENT sur un preset — jamais de rapprochement vers le plus proche.
  const changerPeriode = (patch: Partial<Periode>) => {
    const dates = { ...periode, ...patch };
    choisirPeriode({ choix: presetCorrespondant(dates, aujourdhui, configExercice) ?? "personnalise", personnalisee: dates });
    apresChangementDePeriode();
  };

  // Choix dans la liste : un preset garde en réserve la dernière période libre ; « Personnalisé »
  // part des dates affichées.
  const choisirPreset = (choix: ChoixPeriode) => {
    choisirPeriode({ choix, personnalisee: choix === "personnalise" ? periode : selectionCourante.personnalisee });
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

  // Export PDF : une page par onglet de résultats, sur la période active. Seul l'onglet affiché a
  // des filtres locaux connus ; les autres pages sont exportées sans filtre.
  const exportPossible = periodeOk && !chargement && !erreurChargement && !axeAConfigurer;
  const exporterPdf = async () => {
    if (exportEnCours || !exportPossible) return;
    setExportEnCours(true);
    setExportErreur(null);
    try {
      const avertissements: string[] = [];
      if (nombreNonCategorisees > 0) {
        avertissements.push(
          `${pluriel(nombreNonCategorisees, "transaction non catégorisée", "transactions non catégorisées")} sur la période, hors reporting.`
        );
      }
      if (pnl.nonMappees.nombreCategories > 0) {
        avertissements.push(
          `Reporting incomplet : ${pluriel(pnl.nonMappees.nombreCategories, "catégorie reste", "catégories restent")} à mapper (${formatMontantComptable(pnl.nonMappees.montant)} exclus des calculs).`
        );
      }
      if (nombreSignesInhabituels > 0) {
        avertissements.push(
          `${pluriel(nombreSignesInhabituels, "transaction avec un signe inhabituel", "transactions avec un signe inhabituel")}, prises en compte telles quelles.`
        );
      }
      const pages = pagesExportPdf({
        pnl,
        parts: partsDetail,
        periode,
        ajustements,
        avertissements,
        ongletOuvert: vue,
        filtresOngletOuvert: estMetriqueDetail(vue) ? filtresOngletOuvert.current : { categorie: null, mois: null },
      });
      const { genererPdfPasse, telechargerPdf } = await import("@/lib/pastPdfDocument");
      const blob = await genererPdfPasse({ organisation: organizationName, periode, pages, teintes: teintesCategories });
      telechargerPdf(blob, nomFichierPdf(organizationName, periode));
    } catch (error) {
      console.error("Échec de l'export PDF du module Passé :", error);
      setExportErreur("Le PDF n'a pas pu être généré. Réessayez.");
    } finally {
      setExportEnCours(false);
    }
  };

  return (
    <section className="passe">
      <div className="passe__decor-haut" aria-hidden="true" />
      <div className="passe__decor-bas" aria-hidden="true" />
      <div className="passe-controles">
        <div className="passe-controle passe-axe">
          <label className="passe-controle__label" htmlFor="passe-periode-preset">
            Période
          </label>
          <select
            id="passe-periode-preset"
            value={selectionCourante.choix}
            onChange={(e) => choisirPreset(e.target.value as ChoixPeriode)}
          >
            {GROUPES_PRESETS.map((groupe) => (
              <optgroup key={groupe} label={groupe}>
                {PRESETS_PERIODE.filter((preset) => preset.groupe === groupe).map((preset) => {
                  const dates = periodeDuPreset(preset.cle, aujourdhui, configExercice);
                  return (
                    <option key={preset.cle} value={preset.cle}>
                      {preset.libelle} — {formatDateCourte(dates.debut)} → {formatDateCourte(dates.fin)}
                    </option>
                  );
                })}
              </optgroup>
            ))}
            <option value="personnalise">Personnalisé</option>
          </select>
          <DateField value={periode.debut} onChange={(v) => changerPeriode({ debut: v })} effacable={false} />
          <span className="passe-controle__separateur">→</span>
          <DateField value={periode.fin} onChange={(v) => changerPeriode({ fin: v })} effacable={false} />

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
          <button type="button" className="btn-secondaire" onClick={exporterPdf} disabled={exportEnCours || !exportPossible}>
            {exportEnCours ? "Génération du PDF…" : "Exporter en PDF"}
          </button>
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
        {ONGLETS.filter((onglet) => !("horsNavigation" in onglet)).map((onglet) => (
          <button
            key={onglet.cle}
            type="button"
            role="tab"
            aria-selected={vue === onglet.cle}
            className={`passe-onglet${vue === onglet.cle ? " passe-onglet--actif" : ""}`}
            onClick={() => setVue(onglet.cle)}
          >
            {onglet.libelle}
            {onglet.cle === "mapping" && nombreAMapper > 0 && (
              <span className="passe-onglet__pastille">{nombreAMapper}</span>
            )}
          </button>
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
          ) : (
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

          {!axeAConfigurer && detailSignesOuvert && (nombreSignesInhabituels > 0 || nombreSignesValides > 0) && (
            <div className="passe-signes-detail">
              <div className="passe-tri" role="group" aria-label="Signes inhabituels à afficher">
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
                        <th className="col-montant">Montant</th>
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

          {!axeAConfigurer && vue !== "mapping" && vue !== "transactions" && vue !== "stocks" && pnl.nonMappees.nombreCategories > 0 && (
            <p className="passe-message">
              Reporting incomplet :{" "}
              {pnl.nonMappees.nombreCategories > 1
                ? `${pnl.nonMappees.nombreCategories} catégories utilisées sur la période restent à mapper`
                : "1 catégorie utilisée sur la période reste à mapper"}{" "}
              ({formatMontantComptable(pnl.nonMappees.montant)} exclus des calculs).
            </p>
          )}

          {axeAConfigurer ? null : vue === "general" ? (
            <PasseGeneral pnl={pnl} teintes={teintesCategories} />
          ) : estMetriqueDetail(vue) ? (
            // `key` : changer d'onglet remonte l'écran, donc réinitialise ses filtres locaux
            // (catégorie, mois) ; la période, elle, vit ici et reste inchangée.
            <PastDetailDashboard
              key={vue}
              metrique={vue}
              parts={partsDetail}
              periode={periode}
              ajustements={ajustements}
              teintes={teintesCategories}
              onFiltresChange={retenirFiltresOnglet}
            />
          ) : vue === "stocks" ? (
            <PasseStocks
              mois={moisDeLaPeriode(periode)}
              stocks={stocks}
              onEnregistrer={enregistrerStock}
              onSupprimer={retirerStock}
            />
          ) : vue === "mapping" ? (
            <PasseMappingTable
              lignes={lignesCorrespondance}
              filtre={filtreMapping}
              onChangeFiltre={setFiltreMapping}
              onChangeEtage={changerEtage}
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
    </section>
  );
}
