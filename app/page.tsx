"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import dynamic from "next/dynamic";
import { useRouter } from "next/navigation";
import type { Session } from "@supabase/supabase-js";
import Dashboard from "@/components/Dashboard";
import SyntheseMensuelle from "@/components/SyntheseMensuelle";
import FacturesClientsTable from "@/components/FacturesClientsTable";
import FacturesFournisseursTable from "@/components/FacturesFournisseursTable";
import ChargesFixesTable from "@/components/ChargesFixesTable";
import AutresDepensesTable from "@/components/AutresDepensesTable";
import FinancementsTable from "@/components/FinancementsTable";
import RentreesRegulieresTable from "@/components/RentreesRegulieresTable";
import SectionRepliable from "@/components/SectionRepliable";
import BarreRecherche from "@/components/BarreRecherche";
import BandeauPeriodeFiltre from "@/components/BandeauPeriodeFiltre";
import ControleMensuel from "@/components/ControleMensuel";
import FiabiliteProjection from "@/components/FiabiliteProjection";
import LoginForm from "@/components/LoginForm";
import IconTelechargement from "@/components/IconTelechargement";
import EnTeteCockpit from "@/components/EnTeteCockpit";
import OffreVerrouillee from "@/components/OffreVerrouillee";
import Cartouche from "@/components/Cartouche";
import { formatDate } from "@/lib/format";

const ImportFactures = dynamic(() => import("@/components/ImportFactures"), { ssr: false });
const ImportHistoriqueBancaire = dynamic(() => import("@/components/ImportHistoriqueBancaire"), { ssr: false });
const VerifierMesDonnees = dynamic(() => import("@/components/VerifierMesDonnees"), { ssr: false });
import {
  calculerSynchronisation,
  candidatVersFactureClient,
  candidatVersFactureFournisseur,
  MiseAJourDocument,
  RattachementPropose,
  ResultatSyncPennylane,
} from "@/lib/pennylaneInvoiceAdapter";
import {
  appliquerFusion,
  rattacherAPennylane,
  ChoixFusion,
  clePaire,
  detecterDoublons,
  FactureFusionnable,
  PaireDoublon,
  PropositionFusion,
} from "@/lib/doublonsFactures";
import DoublonsFactures from "@/components/DoublonsFactures";
import { calculerProjectionCash } from "@/lib/cash-engine";
import { estFactureMasquee, reglementReelARecuperer, todayISO } from "@/lib/dates";
import { calculerSyntheseMensuelle } from "@/lib/syntheseMensuelle";
import { calculerControleMensuel } from "@/lib/controleMensuel";
import { calculerFluxPeriode, calculerPeriodeFiltre } from "@/lib/periodeFiltre";
import { montantOccurrenceRentreeReguliere, repartitionUniforme } from "@/lib/saisonnalite";
import {
  chargesUtilisantCommeSource,
  messageBlocageConversion,
  messageBlocageSuppression,
  montantApercuChargeFixe,
} from "@/lib/montantCalcule";
import {
  filtrerAutresDepenses,
  filtrerChargesFixes,
  filtrerFacturesClients,
  filtrerFacturesFournisseurs,
  filtrerFinancements,
  filtrerRentreesRegulieres,
} from "@/lib/recherche";
import {
  SOLDE_BANCAIRE_INITIAL,
  mockAutresDepenses,
  mockChargesFixes,
  mockFacturesClients,
  mockFacturesFournisseurs,
  mockFinancements,
  mockRentreesRegulieres,
} from "@/lib/mockData";
import {
  AutreDepense,
  ChargeFixe,
  FactureClient,
  FactureFournisseur,
  Financement,
  HorizonJours,
  LienRapprochement,
  MappingFournisseurCharge,
  RentreeReguliere,
  TriMode,
} from "@/lib/types";
import {
  CandidatRapprochement,
  construireLien,
  construireMapping,
  detacherFactures,
  liensARattacher,
  occurrencesRapprochables,
  proposerRapprochements,
  resoudreRemplacements,
} from "@/lib/rapprochementChargesFixes";
import RapprochementChargesFixes, { CibleRapprochement } from "@/components/RapprochementChargesFixes";
import { RapprochementFacture } from "@/components/FacturesFournisseursTable";
import { ajouterJours, parseDateISO } from "@/lib/dates";
import { supabase, supabaseConfigured } from "@/lib/supabaseClient";
import { getOrCreateCompanyForBilling } from "@/lib/billing";
import { moduleActifPourOrganisation, ROUTE_PASSE } from "@/lib/organizationModules";
import { chargerDroitsOrganisation, Offre } from "@/lib/offres";
import {
  categoriesARelire,
  CategorieFacture,
  CORRESPONDANCE_VIDE,
  CorrespondanceFutur,
  EtageDepense,
} from "@/lib/futurPnl";
import {
  chargerOuInitialiserDonnees,
  sauvegarderAutreDepense,
  sauvegarderChargeFixe,
  affecterEtagePnlManuel,
  chargerCorrespondanceFutur,
  TableDepense,
  importerChargesFixes,
  importerFacturesClients,
  importerFacturesFournisseurs,
  marquerFacturesClientsPayees,
  marquerFacturesFournisseursPayees,
  sauvegarderDateReleve,
  sauvegarderFactureClient,
  sauvegarderFactureFournisseur,
  sauvegarderFinancement,
  sauvegarderHorizonJours,
  sauvegarderRentreeReguliere,
  sauvegarderSoldeInitial,
  supprimerAutreDepense,
  supprimerChargeFixe,
  supprimerFactureClient,
  supprimerFactureFournisseur,
  supprimerFacturesFournisseurs,
  supprimerFinancement,
  supprimerRentreeReguliere,
  renseignerFournisseursPennylane,
  sauvegarderLienRapprochement,
  sauvegarderMappingFournisseur,
  supprimerLienRapprochement,
  supprimerRefusSansIdentitePennylane,
  actualiserDocumentsFactures,
  chargerDecisionsDoublons,
  DecisionDoublon,
  enregistrerFusion,
  enregistrerPaireDistincte,
  SensFacture,
} from "@/lib/supabaseRepository";

const DELAI_DEBOUNCE_MS = 600;

// Lecture du règlement réel chez Pennylane : au plus 200 factures par synchronisation (un appel
// Pennylane chacune) ; les suivantes le sont à la synchronisation d'après.
const MAX_REGLEMENTS_REELS_PAR_SYNCHRO = 200;

// Catégories Pennylane des factures fournisseurs (étage P&L) : au plus 200 factures relues par
// synchronisation, un appel Pennylane chacune ; les suivantes le sont à la synchronisation d'après.
const MAX_CATEGORIES_PAR_SYNCHRO = 200;

function persist(action: () => Promise<void>) {
  action().catch((error) => console.error("Échec de la sauvegarde Supabase :", error));
}

// Rattache aux factures présentes les décisions de rapprochement dont la facture avait disparu
// (même facture Pennylane, nouvel identifiant interne). Renvoie aussi les liens à réenregistrer.
function rattacherLiens(
  liens: LienRapprochement[],
  factures: FactureFournisseur[]
): { liens: LienRapprochement[]; modifies: LienRapprochement[] } {
  const parLien = new Map(liensARattacher(liens, factures).map((r) => [r.lienId, r.factureFournisseurId]));
  if (parLien.size === 0) return { liens, modifies: [] };
  const modifies: LienRapprochement[] = [];
  const resultat = liens.map((lien) => {
    const factureFournisseurId = parLien.get(lien.id);
    if (!factureFournisseurId) return lien;
    const rattache = { ...lien, factureFournisseurId };
    modifies.push(rattache);
    return rattache;
  });
  return { liens: resultat, modifies };
}

// Détecte la violation de clé étrangère companies_owner_id_fkey (le compte de
// connexion n'existe plus), pour la distinguer d'une simple erreur technique.
function estErreurUtilisateurSupprime(error: unknown): boolean {
  const err = error as { code?: string; message?: string } | null;
  return err?.code === "23503" && Boolean(err.message?.toLowerCase().includes("owner_id"));
}

export default function Home() {
  const router = useRouter();
  const minuteursDebounce = useRef(new Map<string, ReturnType<typeof setTimeout>>());

  const persistDebounce = (cle: string, action: () => Promise<void>) => {
    const minuteurExistant = minuteursDebounce.current.get(cle);
    if (minuteurExistant) clearTimeout(minuteurExistant);
    const minuteur = setTimeout(() => {
      minuteursDebounce.current.delete(cle);
      persist(action);
    }, DELAI_DEBOUNCE_MS);
    minuteursDebounce.current.set(cle, minuteur);
  };

  const [session, setSession] = useState<Session | null>(null);
  const [sessionChargee, setSessionChargee] = useState(!supabaseConfigured);
  const [companyId, setCompanyId] = useState<string | null>(null);
  // "verification" (par défaut, fail-closed) : le cockpit ne s'affiche jamais tant
  // qu'on n'est pas passé explicitement à "autorise" — jamais par défaut/erreur.
  // "hors_offre" : accès au produit valide, mais l'offre de la société n'inclut pas la projection ;
  // aucune donnée du cockpit n'est alors chargée.
  const [etatAcces, setEtatAcces] = useState<"verification" | "autorise" | "hors_offre" | "refuse" | "erreur">(
    !supabaseConfigured ? "autorise" : "verification"
  );
  // Offre effective, connue seulement à l'état "hors_offre" (pour la nommer à l'utilisateur).
  const [offreHorsProjection, setOffreHorsProjection] = useState<Offre | null>(null);
  const [tentativeVerification, setTentativeVerification] = useState(0);
  const [donneesChargees, setDonneesChargees] = useState(!supabaseConfigured);
  // null = pas encore su (état de chargement) ; false par défaut sinon, jamais true tant que
  // /api/pennylane/status n'a pas explicitement confirmé une connexion active pour cette société.
  const [pennylaneConnecte, setPennylaneConnecte] = useState<boolean | null>(null);
  // Déclenchable depuis FacturesClientsTable OU FacturesFournisseursTable (juste à côté de
  // "+ Ajouter une facture") — un seul état partagé, affiché aux deux endroits, quel que soit le
  // bouton cliqué : c'est toujours la même opération complète (les deux catégories à la fois).
  const [syncPennylaneEnCours, setSyncPennylaneEnCours] = useState(false);
  const [syncPennylaneResultat, setSyncPennylaneResultat] = useState<ResultatSyncPennylane | null>(null);
  const [syncPennylaneErreur, setSyncPennylaneErreur] = useState<string | null>(null);
  // Entitlement "past" de la société courante : ne sert qu'à afficher ou non le bouton "Passé"
  // dans l'en-tête (la route /passe revérifie elle-même). false par défaut et en cas d'erreur.
  const [modulePasseActif, setModulePasseActif] = useState(false);
  // Correspondance catégorie -> étage P&L partagée avec Passé, lisible sans le module Passé.
  const [correspondancePnl, setCorrespondancePnl] = useState<CorrespondanceFutur>(CORRESPONDANCE_VIDE);
  // Onglets de Futur : le cockpit opérationnel, et la fiabilité de la projection (contrôles).
  const [ongletFutur, setOngletFutur] = useState<"flux" | "fiabilite">("flux");
  // Échec d'enregistrement d'un étage P&L, par tableau (le classement précédent reste affiché).
  const [erreursEtage, setErreursEtage] = useState<Partial<Record<TableDepense, string>>>({});

  const [soldeInitial, setSoldeInitial] = useState(SOLDE_BANCAIRE_INITIAL);
  const [dateReleve, setDateReleve] = useState(() => todayISO());
  const [horizonJours, setHorizonJours] = useState<HorizonJours>(90);
  const [facturesClients, setFacturesClients] = useState<FactureClient[]>(mockFacturesClients);
  const [facturesFournisseurs, setFacturesFournisseurs] =
    useState<FactureFournisseur[]>(mockFacturesFournisseurs);
  const [chargesFixes, setChargesFixes] = useState<ChargeFixe[]>(mockChargesFixes);
  const [autresDepenses, setAutresDepenses] = useState<AutreDepense[]>(mockAutresDepenses);
  const [financements, setFinancements] = useState<Financement[]>(mockFinancements);
  const [rentreesRegulieres, setRentreesRegulieres] = useState<RentreeReguliere[]>(mockRentreesRegulieres);
  // Rapprochement Factures fournisseurs <-> Charges fixes (voir lib/rapprochementChargesFixes.ts).
  const [liensRapprochement, setLiensRapprochement] = useState<LienRapprochement[]>([]);
  const [mappingsFournisseurs, setMappingsFournisseurs] = useState<MappingFournisseurCharge[]>([]);
  // Nombre de synchronisations Pennylane réussies depuis le chargement : la recherche de doublons
  // n'est proposée qu'après une synchronisation, jamais spontanément.
  const [syncsPennylaneReussies, setSyncsPennylaneReussies] = useState(0);
  const [factureManuelleId, setFactureManuelleId] = useState<string | null>(null);
  // Doublons de factures : factures Pennylane non importées car probablement déjà présentes
  // (proposées après une synchronisation), et décisions enregistrées de l'utilisateur (paires
  // écartées, fusions confirmées).
  const [rattachementsProposes, setRattachementsProposes] = useState<{ client: RattachementPropose[]; fournisseur: RattachementPropose[] }>({
    client: [],
    fournisseur: [],
  });
  const [decisionsDoublons, setDecisionsDoublons] = useState<DecisionDoublon[]>([]);
  const [recherche, setRecherche] = useState("");
  const [tri, setTri] = useState<TriMode>("date");
  const [dateClicCourbe, setDateClicCourbe] = useState<string | null>(null);
  const [exportEnCours, setExportEnCours] = useState(false);

  const dateDepart = dateReleve;

  // Résumé global de la recherche : purement pour l'affichage (compteur / message
  // "aucun résultat"), totalement indépendant du calcul de trésorerie ci-dessous.
  const totalResultatsRecherche = useMemo(() => {
    if (!recherche) return null;
    const facturesClientsActives = facturesClients.filter((f) => !estFactureMasquee(f));
    const facturesFournisseursActives = facturesFournisseurs.filter(
      (f) => !estFactureMasquee(f)
    );
    return (
      filtrerFacturesClients(facturesClientsActives, recherche).length +
      filtrerFacturesFournisseurs(facturesFournisseursActives, recherche).length +
      filtrerChargesFixes(chargesFixes, recherche).length +
      filtrerRentreesRegulieres(rentreesRegulieres, recherche).length +
      filtrerAutresDepenses(autresDepenses, recherche).length +
      filtrerFinancements(financements, recherche).length
    );
  }, [
    recherche,
    facturesClients,
    facturesFournisseurs,
    chargesFixes,
    rentreesRegulieres,
    autresDepenses,
    financements,
  ]);

  useEffect(() => {
    if (!supabaseConfigured) return;

    supabase!.auth.getSession().then(({ data }) => {
      setSession(data.session);
      setSessionChargee(true);
    });

    const {
      data: { subscription },
    } = supabase!.auth.onAuthStateChange((_event, newSession) => {
      setSession(newSession);
    });

    return () => subscription.unsubscribe();
  }, []);

  // État de connexion Pennylane : purement informatif pour l'UI (quel parcours proposer en
  // premier dans "Identifier mes charges fixes" / "Vérifier mes données") — jamais le token
  // lui-même, jamais utilisé pour dériver un company_id (les routes le font elles-mêmes).
  useEffect(() => {
    if (!supabaseConfigured || !session) {
      setPennylaneConnecte(null);
      return;
    }
    let annule = false;
    fetch("/api/pennylane/status", { headers: { Authorization: `Bearer ${session.access_token}` } })
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
  }, [session]);

  // Correspondance P&L de la société (lib/futurPnl.ts) : relue à chaque chargement du cockpit,
  // donc toute modification faite dans Passé s'applique aux dépenses sans choix manuel. Échec
  // (migration absente, réseau) : aucune correspondance, le classement manuel reste disponible.
  useEffect(() => {
    if (!supabaseConfigured || !companyId) {
      setCorrespondancePnl(CORRESPONDANCE_VIDE);
      return;
    }
    let annule = false;
    chargerCorrespondanceFutur()
      .then((correspondance) => {
        if (!annule) setCorrespondancePnl(correspondance);
      })
      .catch((error) => {
        console.error("Correspondance P&L indisponible :", error);
        if (!annule) setCorrespondancePnl(CORRESPONDANCE_VIDE);
      });
    return () => {
      annule = true;
    };
  }, [companyId]);

  useEffect(() => {
    if (!supabaseConfigured || !companyId) {
      setModulePasseActif(false);
      return;
    }
    let annule = false;
    moduleActifPourOrganisation(supabase!, companyId, "past")
      .then((actif) => {
        if (!annule) setModulePasseActif(actif);
      })
      .catch(() => {
        if (!annule) setModulePasseActif(false);
      });
    return () => {
      annule = true;
    };
  }, [companyId]);

  // La vérification d'accès et le chargement des données se rejouent quand L'UTILISATEUR change,
  // pas quand l'objet de session change : Supabase réémet la session (nouvel objet, même
  // utilisateur) à chaque retour sur l'onglet du navigateur et à chaque rafraîchissement de jeton.
  // Dépendre de `session` repassait alors par les écrans d'attente et démontait tout le cockpit
  // (sections repliées, défilement, saisie en cours). Conséquence assumée : revenir sur l'onglet ne
  // recharge plus les données depuis la base.
  const userId = session?.user.id ?? null;

  useEffect(() => {
    if (!supabaseConfigured) return;

    if (!userId) {
      setCompanyId(null);
      setEtatAcces("verification");
      setDonneesChargees(false);
      return;
    }

    let annule = false;
    setEtatAcces("verification");
    setDonneesChargees(false);

    (async () => {
      // Ne jamais faire confiance à la seule présence d'une session en localStorage :
      // getUser() revérifie réellement auprès de Supabase que le compte existe
      // encore et que le token est valide, contrairement à getSession() qui ne
      // fait que relire le stockage local.
      const { data: userData, error: userError } = await supabase!.auth.getUser();
      if (annule) return;

      if (userError || !userData.user) {
        await supabase!.auth.signOut();
        return;
      }

      const company = await getOrCreateCompanyForBilling(supabase!, userData.user);
      if (annule) return;

      if (!company.accessEnabled) {
        setEtatAcces("refuse");
        router.replace("/account/billing");
        return;
      }

      // Offre relue en base à chaque vérification (rechargement compris), avant tout affichage.
      const droits = await chargerDroitsOrganisation(supabase!, company.id);
      if (annule) return;
      if (!droits.capacites.canViewForecast) {
        // Le bouton « Passé » de l'en-tête et le lien de l'écran verrouillé suivent l'entitlement
        // du module, lu ici puisque companyId (et donc l'effet dédié) n'est jamais posé dans ce cas.
        const passeActif = await moduleActifPourOrganisation(supabase!, company.id, "past").catch(() => false);
        if (annule) return;
        setModulePasseActif(passeActif && droits.capacites.canViewReporting);
        setOffreHorsProjection(droits.offreEffective);
        setEtatAcces("hors_offre");
        return;
      }
      setEtatAcces("autorise");

      const donnees = await chargerOuInitialiserDonnees(company.id);
      if (annule) return;
      setCompanyId(company.id);
      setSoldeInitial(donnees.soldeInitial);
      setDateReleve(donnees.dateReleve);
      setHorizonJours(donnees.horizonJours);
      setFacturesClients(donnees.facturesClients);
      setFacturesFournisseurs(donnees.facturesFournisseurs);
      setChargesFixes(donnees.chargesFixes);
      setAutresDepenses(donnees.autresDepenses);
      setFinancements(donnees.financements);
      setRentreesRegulieres(donnees.rentreesRegulieres);
      setMappingsFournisseurs(donnees.mappingsFournisseurs);
      // Une facture Pennylane supprimée puis réimportée retrouve ses décisions de rapprochement.
      const rattaches = rattacherLiens(donnees.liensRapprochement, donnees.facturesFournisseurs);
      setLiensRapprochement(rattaches.liens);
      persist(async () => {
        for (const lien of rattaches.modifies) await sauvegarderLienRapprochement(company.id, lien);
      });
      setDonneesChargees(true);
      // Décisions sur les doublons : leur échec n'empêche pas le cockpit de s'ouvrir.
      chargerDecisionsDoublons(company.id)
        .then((decisions) => {
          if (!annule) setDecisionsDoublons(decisions);
        })
        .catch((error) => console.error("Décisions sur les doublons illisibles :", error));
    })().catch((error) => {
      if (annule) return;
      console.error("Échec de la vérification d'accès :", error);
      // Le compte a pu être supprimé entre-temps (violation de la clé étrangère
      // owner_id -> auth.users lors de la création de la société) : on traite ça
      // comme une session invalide, pas comme une simple erreur technique.
      if (estErreurUtilisateurSupprime(error)) {
        supabase!.auth.signOut().catch(() => {});
        return;
      }
      setEtatAcces("erreur");
    });

    return () => {
      annule = true;
    };
  }, [userId, router, tentativeVerification]);

  // Occurrences de Charges fixes remplacées par une facture (rapprochements confirmés) et liens
  // « à revoir ». Dérivé de l'état courant, jamais stocké : lu par tous les calculs ci-dessous.
  const resolutionRapprochement = useMemo(
    () =>
      resoudreRemplacements(
        liensRapprochement,
        chargesFixes,
        facturesFournisseurs,
        ajouterJours(parseDateISO(dateDepart), horizonJours)
      ),
    [liensRapprochement, chargesFixes, facturesFournisseurs, dateDepart, horizonJours]
  );
  const remplacements = resolutionRapprochement.remplacements;

  const resultat = useMemo(
    () =>
      calculerProjectionCash({
        soldeInitial,
        facturesClients,
        facturesFournisseurs,
        chargesFixes,
        autresDepenses,
        financements,
        rentreesRegulieres,
        dateDepart,
        horizonJours,
        remplacements,
      }),
    [
      soldeInitial,
      facturesClients,
      facturesFournisseurs,
      chargesFixes,
      autresDepenses,
      financements,
      rentreesRegulieres,
      dateDepart,
      horizonJours,
      remplacements,
    ]
  );

  // Synthèse mensuelle : calcul indépendant, purement pour l'affichage du panneau
  // gauche. N'affecte jamais `resultat` (KPIs + courbe) ci-dessus.
  const syntheseMensuelle = useMemo(
    () =>
      calculerSyntheseMensuelle({
        dateReleve,
        horizonJours,
        facturesClients,
        facturesFournisseurs,
        chargesFixes,
        autresDepenses,
        financements,
        rentreesRegulieres,
        remplacements,
      }),
    [
      dateReleve,
      horizonJours,
      facturesClients,
      facturesFournisseurs,
      chargesFixes,
      autresDepenses,
      financements,
      rentreesRegulieres,
      remplacements,
    ]
  );

  // Filtre de période issu d'un clic sur la courbe : purement un filtre d'affichage
  // du panneau droit, calculé côté interface. N'affecte jamais `resultat` ni la courbe
  // ci-dessus (aucune de ces deux valeurs ne dépend de dateClicCourbe/periodeFiltre).
  const periodeFiltre = useMemo(
    () => (dateClicCourbe ? calculerPeriodeFiltre(dateClicCourbe, dateReleve, horizonJours) : null),
    [dateClicCourbe, dateReleve, horizonJours]
  );

  const fluxPeriode = useMemo(
    () =>
      periodeFiltre
        ? calculerFluxPeriode({
            debut: periodeFiltre.debut,
            fin: periodeFiltre.fin,
            facturesClients,
            facturesFournisseurs,
            chargesFixes,
            autresDepenses,
            financements,
            rentreesRegulieres,
            remplacements,
          })
        : null,
    [
      periodeFiltre,
      facturesClients,
      facturesFournisseurs,
      chargesFixes,
      autresDepenses,
      financements,
      rentreesRegulieres,
      remplacements,
    ]
  );

  const handleClicCourbe = (date: string) => setDateClicCourbe(date);
  const handleRevenirVueGenerale = () => setDateClicCourbe(null);

  // Exporte exactement ce qui est actuellement visible dans le panneau droit (recherche, tri,
  // filtre de période) : réutilise les mêmes états que ceux passés aux tableaux ci-dessous,
  // aucune nouvelle logique de filtrage. L'onglet Synthèse reprend `resultat`/`syntheseMensuelle`
  // tels quels (jamais recalculés), indépendants des filtres — comme le panneau gauche.
  const handleExporterExcel = async () => {
    setExportEnCours(true);
    try {
      // Chargement différé au clic : evite d'alourdir le chargement initial de la page pour
      // tous les utilisateurs avec la librairie Excel (~250 Ko), non nécessaire tant que
      // personne n'exporte (même principe que le chargement différé d'ImportFactures).
      const { genererExportExcel, nomFichierExportExcel } = await import("@/lib/exportExcel");
      const blob = await genererExportExcel({
        recherche,
        tri,
        soldeInitial,
        dateReleve,
        horizonJours,
        resultat,
        syntheseMensuelle,
        facturesClients,
        facturesFournisseurs,
        chargesFixes,
        autresDepenses,
        financements,
        rentreesRegulieres,
        filtresParCategorie: {
          facturesClients: fluxPeriode?.idsFacturesClients ?? null,
          facturesFournisseurs: fluxPeriode?.idsFacturesFournisseurs ?? null,
          chargesFixes: fluxPeriode?.occurrencesChargesFixes ?? null,
          autresDepenses: fluxPeriode?.idsAutresDepenses ?? null,
          financements: fluxPeriode?.idsFinancements ?? null,
          rentreesRegulieres: fluxPeriode?.occurrencesRentreesRegulieres ?? null,
        },
        periodeFiltre,
      });
      const url = URL.createObjectURL(blob);
      const lien = document.createElement("a");
      lien.href = url;
      lien.download = nomFichierExportExcel();
      lien.click();
      URL.revokeObjectURL(url);
    } finally {
      setExportEnCours(false);
    }
  };

  // Contrôle mensuel : totaux Novanta en lecture seule sur les 3 derniers mois calendaires
  // complets, indépendant de dateReleve/horizonJours. N'affecte jamais resultat/syntheseMensuelle.
  const controleMensuel = useMemo(
    () =>
      calculerControleMensuel({
        facturesClients,
        facturesFournisseurs,
        chargesFixes,
        autresDepenses,
        financements,
        rentreesRegulieres,
        remplacements,
      }),
    [facturesClients, facturesFournisseurs, chargesFixes, autresDepenses, financements, rentreesRegulieres, remplacements]
  );

  // Doublons potentiels facture fournisseur <-> Charge fixe : recherchés automatiquement après
  // chaque synchronisation Pennylane réussie, à partir de l'état synchronisé. Rien n'est
  // neutralisé ici : ce ne sont que des propositions, soumises à l'utilisateur.
  const parametresRapprochement = useMemo(
    () => ({
      facturesFournisseurs,
      chargesFixes,
      rentreesRegulieres,
      liens: liensRapprochement,
      mappings: mappingsFournisseurs,
      dateReleve,
      horizonJours,
    }),
    [facturesFournisseurs, chargesFixes, rentreesRegulieres, liensRapprochement, mappingsFournisseurs, dateReleve, horizonJours]
  );
  const propositionsRapprochement = useMemo(
    () => (syncsPennylaneReussies > 0 ? proposerRapprochements(parametresRapprochement) : []),
    [syncsPennylaneReussies, parametresRapprochement]
  );
  const nombrePropositions = propositionsRapprochement.length;
  // Après une synchronisation qui révèle des doublons potentiels, le bloc de validation est amené
  // à l'écran : l'utilisateur n'a pas à le chercher ni à cliquer une seconde fois.
  useEffect(() => {
    if (syncsPennylaneReussies === 0 || nombrePropositions === 0) return;
    document.getElementById("rapprochement-charges-fixes")?.scrollIntoView({ behavior: "smooth", block: "center" });
    // Uniquement à la fin d'une synchronisation, pas à chaque décision prise ensuite.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [syncsPennylaneReussies]);

  const rapprochementsParFacture = useMemo(() => {
    const parFacture = new Map<string, RapprochementFacture>();
    for (const lien of liensRapprochement) {
      if (lien.statut !== "confirme" || !lien.factureFournisseurId) continue;
      parFacture.set(lien.factureFournisseurId, {
        lienId: lien.id,
        libelleCharge: chargesFixes.find((c) => c.id === lien.chargeFixeId)?.libelle ?? "",
        dateOccurrence: resolutionRapprochement.occurrenceParLien.get(lien.id) ?? lien.dateOccurrence,
      });
    }
    return parFacture;
  }, [liensRapprochement, chargesFixes, resolutionRapprochement]);

  const handleConfirmerRapprochement = (factureId: string, cible: CibleRapprochement) => {
    const facture = facturesFournisseurs.find((f) => f.id === factureId);
    if (!facture) return;
    const memeCouple = (l: LienRapprochement) =>
      l.chargeFixeId === cible.chargeFixeId &&
      (l.factureFournisseurId === facture.id || (Boolean(facture.pennylaneId) && l.facturePennylaneId === facture.pennylaneId));
    // Lien réutilisé plutôt que dupliqué : celui qui tient déjà l'occurrence (sa facture a disparu),
    // sinon une décision antérieure sur ce même couple (un refus, annulé par ce choix explicite).
    const reutilise =
      liensRapprochement.find((l) => l.id === cible.lienARemplacerId) ?? liensRapprochement.find(memeCouple) ?? null;
    const lien = construireLien(facture, cible.chargeFixeId, cible.dateOccurrence, "confirme", reutilise?.id);
    const obsoletes = liensRapprochement.filter((l) => l.id !== lien.id && memeCouple(l));
    const mapping = construireMapping(facture, cible.chargeFixeId, mappingsFournisseurs);

    setLiensRapprochement((prev) => [...prev.filter((l) => l.id !== lien.id && !obsoletes.includes(l)), lien]);
    if (mapping) setMappingsFournisseurs((prev) => [...prev, mapping]);
    setFactureManuelleId(null);
    if (companyId) {
      persist(async () => {
        for (const obsolete of obsoletes) await supprimerLienRapprochement(obsolete.id);
        await sauvegarderLienRapprochement(companyId, lien);
        if (mapping) await sauvegarderMappingFournisseur(companyId, mapping);
      });
    }
  };

  // « Ce n'est pas la même dépense » : aucun effet sur la projection, le couple n'est plus reproposé.
  const handleRefuserRapprochement = (factureId: string, candidats: CandidatRapprochement[]) => {
    const facture = facturesFournisseurs.find((f) => f.id === factureId);
    if (!facture) return;
    const refus = candidats.map((c) => construireLien(facture, c.chargeFixeId, c.dateOccurrence, "refuse"));
    setLiensRapprochement((prev) => [...prev, ...refus]);
    if (companyId) {
      persist(async () => {
        for (const lien of refus) await sauvegarderLienRapprochement(companyId, lien);
      });
    }
  };

  // Décision explicite de l'utilisateur : le rapprochement est supprimé, l'occurrence prévue revient.
  const handleDissocierRapprochement = (lienId: string) => {
    setLiensRapprochement((prev) => prev.filter((l) => l.id !== lienId));
    if (companyId) persist(() => supprimerLienRapprochement(lienId));
  };

  const handleLaisserRemplacee = (lienId: string) => {
    const lien = liensRapprochement.find((l) => l.id === lienId);
    if (!lien) return;
    const ecarte = { ...lien, revueEcarteeLe: new Date().toISOString() };
    setLiensRapprochement((prev) => prev.map((l) => (l.id === lienId ? ecarte : l)));
    if (companyId) persist(() => sauvegarderLienRapprochement(companyId, ecarte));
  };

  const handleChangeSoldeInitial = (valeur: number) => {
    setSoldeInitial(valeur);
    if (companyId) persistDebounce("soldeInitial", () => sauvegarderSoldeInitial(companyId, valeur));
  };

  const handleChangeHorizonJours = (valeur: HorizonJours) => {
    setHorizonJours(valeur);
    if (companyId) persistDebounce("horizonJours", () => sauvegarderHorizonJours(companyId, valeur));
  };

  const handleChangeDateReleve = (valeur: string) => {
    if (!valeur) return;
    setDateReleve(valeur);
    if (companyId) persistDebounce("dateReleve", () => sauvegarderDateReleve(companyId, valeur));
  };

  const handleChangeFactureClient = (id: string, patch: Partial<FactureClient>) => {
    setFacturesClients((prev) => {
      const suivant = prev.map((f) => (f.id === id ? { ...f, ...patch } : f));
      const facture = suivant.find((f) => f.id === id);
      if (companyId && facture) {
        persistDebounce(`factureClient:${id}`, () => sauvegarderFactureClient(companyId, facture));
      }
      return suivant;
    });
  };

  const handleAddFactureClient = () => {
    const facture: FactureClient = {
      id: crypto.randomUUID(),
      facture: "",
      client: "",
      montant: 0,
      dateEcheance: "",
      dateEncaissementAnticipee: "",
      litigieuse: false,
      payee: false,
      paidAt: null,
    };
    setFacturesClients((prev) => [...prev, facture]);
    if (companyId) persist(() => sauvegarderFactureClient(companyId, facture));
  };

  const handleRemoveFactureClient = (id: string) => {
    setFacturesClients((prev) => prev.filter((f) => f.id !== id));
    if (companyId) persist(() => supprimerFactureClient(id));
  };

  const handleChangeFactureFournisseur = (id: string, patch: Partial<FactureFournisseur>) => {
    setFacturesFournisseurs((prev) => {
      const suivant = prev.map((f) => (f.id === id ? { ...f, ...patch } : f));
      const facture = suivant.find((f) => f.id === id);
      if (companyId && facture) {
        persistDebounce(`factureFournisseur:${id}`, () => sauvegarderFactureFournisseur(companyId, facture));
      }
      return suivant;
    });
  };

  const handleAddFactureFournisseur = () => {
    const facture: FactureFournisseur = {
      id: crypto.randomUUID(),
      facture: "",
      fournisseur: "",
      montant: 0,
      dateEcheance: "",
      datePaiementPrevue: "",
      litigieuse: false,
      payee: false,
      paidAt: null,
    };
    setFacturesFournisseurs((prev) => [...prev, facture]);
    if (companyId) persist(() => sauvegarderFactureFournisseur(companyId, facture));
  };

  const handleRemoveFactureFournisseur = (id: string) => {
    setFacturesFournisseurs((prev) => prev.filter((f) => f.id !== id));
    // Un rapprochement confirmé survit à sa facture : l'occurrence reste remplacée, à revoir.
    setLiensRapprochement((prev) => detacherFactures(prev, [id]));
    if (companyId) {
      persist(async () => {
        await supprimerRefusSansIdentitePennylane([id]);
        await supprimerFactureFournisseur(id);
      });
    }
  };

  const handleImporterFactures = (
    nouvellesFacturesClients: FactureClient[],
    nouvellesFacturesFournisseurs: FactureFournisseur[]
  ) => {
    if (nouvellesFacturesClients.length > 0) {
      setFacturesClients((prev) => [...prev, ...nouvellesFacturesClients]);
      if (companyId) persist(() => importerFacturesClients(companyId, nouvellesFacturesClients));
    }
    if (nouvellesFacturesFournisseurs.length > 0) {
      setFacturesFournisseurs((prev) => [...prev, ...nouvellesFacturesFournisseurs]);
      if (companyId) persist(() => importerFacturesFournisseurs(companyId, nouvellesFacturesFournisseurs));
    }
  };

  // Synchronisation Pennylane des factures : le diff (insertion vs mise à jour) est déjà calculé
  // par ImportFactures.tsx (lib/pennylaneInvoiceAdapter.ts::calculerSynchronisation) — ce handler
  // ne fait qu'appliquer le résultat, exactement comme handleImporterFactures pour les nouvelles
  // factures. Les mises à jour "Payée" ne touchent JAMAIS que payee/paidAt (voir
  // marquerFacturesClientsPayees/Fournisseurs), jamais dateEcheance/litigieuse/autres réglages
  // utilisateur.
  const handleSynchroniserPennylaneFactures = (
    nouvellesFacturesClients: FactureClient[],
    nouvellesFacturesFournisseurs: FactureFournisseur[],
    idsClientsAMettreAJourPayee: string[],
    idsFournisseursAMettreAJourPayee: string[],
    idsFournisseursASupprimer: string[],
    fournisseursARenseigner: { id: string; pennylaneSupplierId: string }[] = []
  ): Promise<void> => {
    // Écritures « Payée » attendues par l'appelant : la lecture du règlement réel ne porte que sur
    // des factures déjà enregistrées payées en base.
    const marquages: Promise<void>[] = [];
    if (nouvellesFacturesClients.length > 0) {
      setFacturesClients((prev) => [...prev, ...nouvellesFacturesClients]);
      if (companyId) persist(() => importerFacturesClients(companyId, nouvellesFacturesClients));
    }
    // Identifiant fournisseur Pennylane des factures déjà importées : seul ce champ est renseigné.
    const fournisseurParFacture = new Map(fournisseursARenseigner.map((r) => [r.id, r.pennylaneSupplierId]));
    if (nouvellesFacturesFournisseurs.length > 0 || fournisseurParFacture.size > 0) {
      setFacturesFournisseurs((prev) => [
        ...prev.map((f) => (fournisseurParFacture.has(f.id) ? { ...f, pennylaneSupplierId: fournisseurParFacture.get(f.id) } : f)),
        ...nouvellesFacturesFournisseurs,
      ]);
    }
    // Décisions de rapprochement : détachées des factures retirées, rattachées aux factures
    // réimportées (même facture Pennylane, nouvel identifiant interne).
    const idsRetires = new Set(idsFournisseursASupprimer);
    const facturesApres = [...facturesFournisseurs.filter((f) => !idsRetires.has(f.id)), ...nouvellesFacturesFournisseurs];
    const rattaches = rattacherLiens(detacherFactures(liensRapprochement, idsFournisseursASupprimer), facturesApres);
    setLiensRapprochement(rattaches.liens);
    if (companyId) {
      // Une seule chaîne ordonnée : un lien ne peut référencer une facture qu'une fois celle-ci insérée.
      // Attendue avec les marquages : la lecture des catégories Pennylane qui suit porte aussi sur
      // les nouvelles factures, et le serveur ne lit que des factures déjà en base.
      marquages.push(
        (async () => {
          await importerFacturesFournisseurs(companyId, nouvellesFacturesFournisseurs);
          await renseignerFournisseursPennylane(fournisseursARenseigner);
          for (const lien of rattaches.modifies) await sauvegarderLienRapprochement(companyId, lien);
        })().catch((error) => console.error("Échec de la sauvegarde Supabase :", error))
      );
    }

    if (idsClientsAMettreAJourPayee.length > 0) {
      const idsAMettreAJour = new Set(idsClientsAMettreAJourPayee);
      const maintenant = new Date().toISOString();
      setFacturesClients((prev) =>
        prev.map((f) => (idsAMettreAJour.has(f.id) ? { ...f, payee: true, paidAt: maintenant } : f))
      );
      marquages.push(marquerFacturesClientsPayees(idsClientsAMettreAJourPayee).catch((error) => console.error("Échec de la sauvegarde Supabase :", error)));
    }
    if (idsFournisseursAMettreAJourPayee.length > 0) {
      const idsAMettreAJour = new Set(idsFournisseursAMettreAJourPayee);
      const maintenant = new Date().toISOString();
      setFacturesFournisseurs((prev) =>
        prev.map((f) => (idsAMettreAJour.has(f.id) ? { ...f, payee: true, paidAt: maintenant } : f))
      );
      marquages.push(marquerFacturesFournisseursPayees(idsFournisseursAMettreAJourPayee).catch((error) => console.error("Échec de la sauvegarde Supabase :", error)));
    }
    // Versions archivées dans Pennylane : ce ne sont plus des factures de trésorerie.
    if (idsFournisseursASupprimer.length > 0) {
      const idsASupprimer = new Set(idsFournisseursASupprimer);
      setFacturesFournisseurs((prev) => prev.filter((f) => !idsASupprimer.has(f.id)));
      persist(async () => {
        await supprimerRefusSansIdentitePennylane(idsFournisseursASupprimer);
        await supprimerFacturesFournisseurs(idsFournisseursASupprimer);
      });
    }
    return Promise.all(marquages).then(() => undefined);
  };

  // Pennylane a modifié le document d'une facture déjà liée : n°, tiers, montant et échéance sont
  // actualisés ; la date prévue ne l'est que si elle suivait l'échéance (réglage Novanta conservé).
  const appliquerMisesAJourDocument = (sens: SensFacture, misesAJour: MiseAJourDocument[]) => {
    if (misesAJour.length === 0) return;
    const parId = new Map(misesAJour.map((m) => [m.id, m]));
    if (sens === "client") {
      setFacturesClients((prev) =>
        prev.map((f) => {
          const m = parId.get(f.id);
          return m ? { ...f, facture: m.facture, client: m.tiers, montant: m.montant, dateEcheance: m.dateEcheance, dateEncaissementAnticipee: m.datePrevue ?? f.dateEncaissementAnticipee } : f;
        })
      );
      persist(() => actualiserDocumentsFactures("client", misesAJour));
    } else {
      setFacturesFournisseurs((prev) =>
        prev.map((f) => {
          const m = parId.get(f.id);
          return m ? { ...f, facture: m.facture, fournisseur: m.tiers, montant: m.montant, dateEcheance: m.dateEcheance, datePaiementPrevue: m.datePrevue ?? f.datePaiementPrevue } : f;
        })
      );
      persist(() => actualiserDocumentsFactures("fournisseur", misesAJour));
    }
  };

  /**
   * Règlement réel des factures Pennylane payées encore visibles (lib/dates.ts::
   * reglementReelARecuperer) : lu chez Pennylane par le serveur, qui l'écrit en base ; l'état local
   * suit. Sans incidence sur la synchronisation elle-même : une erreur laisse simplement le
   * masquage partir de la date de paiement Novanta.
   */
  const recupererReglementsReels = async (
    clients: FactureClient[],
    fournisseurs: FactureFournisseur[]
  ): Promise<void> => {
    if (!session?.access_token) return;
    const maintenant = new Date();
    const lots: [ "client" | "fournisseur", string[] ][] = [
      ["client", clients.filter((f) => reglementReelARecuperer(f, maintenant)).map((f) => f.id)],
      ["fournisseur", fournisseurs.filter((f) => reglementReelARecuperer(f, maintenant)).map((f) => f.id)],
    ];
    for (const [type, ids] of lots) {
      for (let i = 0; i < ids.length && i < MAX_REGLEMENTS_REELS_PAR_SYNCHRO; i += 50) {
        try {
          const res = await fetch("/api/pennylane/invoices/settlement", {
            method: "POST",
            headers: { Authorization: `Bearer ${session.access_token}`, "Content-Type": "application/json" },
            body: JSON.stringify({ type, ids: ids.slice(i, i + 50) }),
          });
          if (!res.ok) return;
          const { reglements } = (await res.json()) as { reglements: { id: string; settledOn: string }[] };
          const parId = new Map(reglements.map((r) => [r.id, r.settledOn]));
          if (parId.size === 0) continue;
          if (type === "client") setFacturesClients((prev) => prev.map((f) => (parId.has(f.id) ? { ...f, settledOn: parId.get(f.id)! } : f)));
          else setFacturesFournisseurs((prev) => prev.map((f) => (parId.has(f.id) ? { ...f, settledOn: parId.get(f.id)! } : f)));
        } catch (error) {
          console.error("Lecture du règlement réel impossible :", error);
          return;
        }
      }
    }
  };

  /**
   * Catégories Pennylane des factures fournisseurs à payer (lib/futurPnl.ts::categoriesARelire),
   * lues par le serveur qui les écrit en base ; l'état local suit. Ne touche jamais au choix
   * manuel d'étage. Une erreur laisse les factures concernées telles quelles (« À classer » ou
   * classement précédent).
   */
  const recupererCategoriesFactures = async (fournisseurs: FactureFournisseur[]): Promise<void> => {
    if (!session?.access_token) return;
    const maintenant = new Date();
    const ids = fournisseurs.filter((f) => categoriesARelire(f, maintenant)).map((f) => f.id);
    for (let i = 0; i < ids.length && i < MAX_CATEGORIES_PAR_SYNCHRO; i += 50) {
      try {
        const res = await fetch("/api/pennylane/invoices/categories", {
          method: "POST",
          headers: { Authorization: `Bearer ${session.access_token}`, "Content-Type": "application/json" },
          body: JSON.stringify({ ids: ids.slice(i, i + 50) }),
        });
        if (!res.ok) return;
        const { lues } = (await res.json()) as { lues: { id: string; categories: CategorieFacture[]; luesLe: string }[] };
        const parId = new Map(lues.map((l) => [l.id, l]));
        if (parId.size === 0) return;
        setFacturesFournisseurs((prev) =>
          prev.map((f) => {
            const lue = parId.get(f.id);
            return lue ? { ...f, categoriesPennylane: lue.categories, categoriesLuesLe: lue.luesLe } : f;
          })
        );
      } catch (error) {
        console.error("Lecture des catégories Pennylane impossible :", error);
        return;
      }
    }
  };

  // Déclenché depuis le bouton "Synchroniser Pennylane" de FacturesClientsTable OU
  // FacturesFournisseursTable (les deux appellent cette même fonction — une seule opération,
  // affichée aux deux endroits). N'est jamais appelé si Pennylane n'est pas connecté : le bouton
  // redirige alors vers /account/integrations à la place (voir les deux tables).
  const handleClicSynchroniserPennylane = async () => {
    if (!session?.access_token || syncPennylaneEnCours) return;
    setSyncPennylaneEnCours(true);
    setSyncPennylaneErreur(null);
    setSyncPennylaneResultat(null);

    try {
      const res = await fetch("/api/pennylane/invoices", {
        method: "POST",
        headers: { Authorization: `Bearer ${session.access_token}` },
      });
      const data = await res.json();
      if (!res.ok) {
        setSyncPennylaneErreur(data.error || "Synchronisation Pennylane impossible. Vérifiez le token et ses autorisations.");
        return;
      }

      const facturesClientsExistantesPourSync = facturesClients.map((f) => ({
        id: f.id,
        pennylaneId: f.pennylaneId,
        payee: f.payee,
        facture: f.facture,
        tiers: f.client,
        montant: f.montant,
        dateEcheance: f.dateEcheance,
        datePrevue: f.dateEncaissementAnticipee,
      }));
      const facturesFournisseursExistantesPourSync = facturesFournisseurs.map((f) => ({
        id: f.id,
        pennylaneId: f.pennylaneId,
        payee: f.payee,
        pennylaneSupplierId: f.pennylaneSupplierId,
        facture: f.facture,
        tiers: f.fournisseur,
        montant: f.montant,
        dateEcheance: f.dateEcheance,
        datePrevue: f.datePaiementPrevue,
      }));
      const rattachements: { client: RattachementPropose[]; fournisseur: RattachementPropose[] } = { client: [], fournisseur: [] };
      let nombreFacturesActualisees = 0;

      let nombreClientsAjoutes = 0;
      let nombreFournisseursAjoutes = 0;
      let idsClientsAMettreAJourPayee: string[] = [];
      let idsFournisseursAMettreAJourPayee: string[] = [];
      let idsFournisseursASupprimer: string[] = [];
      let fournisseursARenseigner: { id: string; pennylaneSupplierId: string }[] = [];
      let nombreIncoherencesFournisseur = 0;
      let nouvellesFacturesClients: FactureClient[] = [];
      let nouvellesFacturesFournisseurs: FactureFournisseur[] = [];

      if (data.clientCandidates) {
        const { aInserer, idsAMettreAJourPayee, aRattacher, misesAJourDocument } = calculerSynchronisation(
          data.clientCandidates,
          facturesClientsExistantesPourSync,
          "client",
          pennylaneIdsFusionnes("client")
        );
        rattachements.client = aRattacher;
        appliquerMisesAJourDocument("client", misesAJourDocument);
        nombreFacturesActualisees += misesAJourDocument.length;
        nouvellesFacturesClients = aInserer.map(candidatVersFactureClient);
        idsClientsAMettreAJourPayee = idsAMettreAJourPayee;
        nombreClientsAjoutes = nouvellesFacturesClients.length;
      }

      if (data.fournisseurCandidates) {
        const {
          aInserer,
          idsAMettreAJourPayee,
          idsASupprimer,
          fournisseursARenseigner: aRenseigner,
          idsIncoherenceFournisseur,
          aRattacher,
          misesAJourDocument,
        } = calculerSynchronisation(
          data.fournisseurCandidates,
          facturesFournisseursExistantesPourSync,
          "fournisseur",
          pennylaneIdsFusionnes("fournisseur")
        );
        fournisseursARenseigner = aRenseigner;
        nombreIncoherencesFournisseur = idsIncoherenceFournisseur.length;
        rattachements.fournisseur = aRattacher;
        appliquerMisesAJourDocument("fournisseur", misesAJourDocument);
        nombreFacturesActualisees += misesAJourDocument.length;
        nouvellesFacturesFournisseurs = aInserer.map(candidatVersFactureFournisseur);
        idsFournisseursAMettreAJourPayee = idsAMettreAJourPayee;
        idsFournisseursASupprimer = idsASupprimer;
        nombreFournisseursAjoutes = nouvellesFacturesFournisseurs.length;
      }

      setRattachementsProposes(rattachements);
      const marquages = handleSynchroniserPennylaneFactures(
        nouvellesFacturesClients,
        nouvellesFacturesFournisseurs,
        idsClientsAMettreAJourPayee,
        idsFournisseursAMettreAJourPayee,
        idsFournisseursASupprimer,
        fournisseursARenseigner
      );

      setSyncPennylaneResultat({
        nombreClientsAnalysees: Array.isArray(data.clientCandidates) ? data.clientCandidates.length : 0,
        nombreFournisseursAnalysees: Array.isArray(data.fournisseurCandidates) ? data.fournisseurCandidates.length : 0,
        nombreClientsAjoutes,
        nombreFournisseursAjoutes,
        nombreMarquesPayees: idsClientsAMettreAJourPayee.length + idsFournisseursAMettreAJourPayee.length,
        nombreArchiveesRetirees: idsFournisseursASupprimer.length,
        nombreIncoherencesFournisseur,
        nombreFacturesActualisees,
        erreurClients: data.erreurClients ?? null,
        erreurFournisseurs: data.erreurFournisseurs ?? null,
      });
      // Synchronisation des factures fournisseurs réussie : la recherche de doublons avec les
      // Charges fixes se lance d'elle-même (voir propositionsRapprochement).
      if (data.fournisseurCandidates) setSyncsPennylaneReussies((n) => n + 1);

      // Factures payées par cette synchronisation, et factures déjà payées encore visibles : leur
      // règlement réel, une fois les marquages enregistrés. En arrière-plan : la synchronisation est
      // terminée pour l'utilisateur ; les lignes concernées disparaissent quand leur date arrive.
      const maintenantIso = new Date().toISOString();
      const marqueesClients = new Set(idsClientsAMettreAJourPayee);
      const marqueesFournisseurs = new Set(idsFournisseursAMettreAJourPayee);
      const clientsApres = facturesClients.map((f) => (marqueesClients.has(f.id) ? { ...f, payee: true, paidAt: maintenantIso } : f));
      const fournisseursApres = facturesFournisseurs.map((f) => (marqueesFournisseurs.has(f.id) ? { ...f, payee: true, paidAt: maintenantIso } : f));
      // Puis les catégories Pennylane des factures fournisseurs (étage P&L), nouvelles comprises :
      // `marquages` attend aussi leur insertion, pour que le serveur les retrouve en base.
      const fournisseursACategoriser = [...fournisseursApres, ...nouvellesFacturesFournisseurs].filter(
        (f) => !idsFournisseursASupprimer.includes(f.id)
      );
      void marquages
        .then(() => recupererReglementsReels(clientsApres, fournisseursApres))
        .then(() => recupererCategoriesFactures(fournisseursACategoriser));
    } catch {
      setSyncPennylaneErreur("Pennylane est temporairement indisponible. Réessayez.");
    } finally {
      setSyncPennylaneEnCours(false);
    }
  };

  // --- Doublons de factures (lib/doublonsFactures.ts) : suggestions, jamais de fusion silencieuse ---

  const commeFusionnableClient = (f: FactureClient): FactureFusionnable => ({
    id: f.id,
    facture: f.facture,
    tiers: f.client,
    montant: f.montant,
    dateEcheance: f.dateEcheance,
    datePrevue: f.dateEncaissementAnticipee,
    payee: f.payee,
    litigieuse: f.litigieuse,
    pennylaneId: f.pennylaneId,
  });
  const commeFusionnableFournisseur = (f: FactureFournisseur): FactureFusionnable => ({
    id: f.id,
    facture: f.facture,
    tiers: f.fournisseur,
    montant: f.montant,
    dateEcheance: f.dateEcheance,
    datePrevue: f.datePaiementPrevue,
    etagePnlManuel: f.etagePnlManuel ?? null,
    payee: f.payee,
    litigieuse: f.litigieuse,
    pennylaneId: f.pennylaneId,
  });
  // Paires écartées (« Ce ne sont pas des doublons ») : enregistrées, jamais reproposées.
  const pairesEcartees = useMemo(
    () => new Set(decisionsDoublons.filter((d) => d.decision === "distinct").map((d) => `${d.sens}:${d.cle}`)),
    [decisionsDoublons]
  );
  // Identifiants Pennylane des lignes retirées par une fusion : la synchronisation ne les réimporte pas.
  const pennylaneIdsFusionnes = (sens: SensFacture) =>
    new Set(decisionsDoublons.filter((d) => d.sens === sens && d.decision === "fusion" && d.pennylaneIdRetire).map((d) => d.pennylaneIdRetire!));
  const nonEcartee = (sens: SensFacture) => (p: PaireDoublon<FactureFusionnable>) => !pairesEcartees.has(`${sens}:${clePaire(p.a.id, p.b.id)}`);
  const doublonsClients = useMemo(
    () => detecterDoublons(facturesClients.map(commeFusionnableClient), "client").filter(nonEcartee("client")),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [facturesClients, pairesEcartees]
  );
  const doublonsFournisseurs = useMemo(
    () => detecterDoublons(facturesFournisseurs.map(commeFusionnableFournisseur), "fournisseur").filter(nonEcartee("fournisseur")),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [facturesFournisseurs, pairesEcartees]
  );

  const retirerProposition = (sens: "client" | "fournisseur", rattachement: RattachementPropose) =>
    setRattachementsProposes((prev) => ({ ...prev, [sens]: prev[sens].filter((r) => r !== rattachement) }));

  // La ligne Novanta reste telle quelle ; elle reçoit l'identifiant de la facture Pennylane, que la
  // synchronisation reconnaîtra désormais (plus jamais d'import en double).
  // Même règle que la fusion (lib/doublonsFactures.ts::rattacherAPennylane) : la ligne prend le
  // document Pennylane et garde ses réglages de prévision Novanta.
  const handleRattacher = (sens: "client" | "fournisseur", rattachement: RattachementPropose) => {
    retirerProposition(sens, rattachement);
    const document = rattachement.candidat;
    if (sens === "client") {
      const existante = facturesClients.find((f) => f.id === rattachement.existanteId);
      if (!existante) return;
      const r = rattacherAPennylane(commeFusionnableClient(existante), document);
      const rattachee: FactureClient = {
        ...existante,
        pennylaneId: r.pennylaneId,
        facture: r.facture,
        client: r.tiers,
        montant: r.montant,
        dateEcheance: r.dateEcheance,
        dateEncaissementAnticipee: r.datePrevue,
        payee: r.payee,
        paidAt: existante.payee ? existante.paidAt : r.payee ? new Date().toISOString() : null,
      };
      setFacturesClients((prev) => prev.map((f) => (f.id === rattachee.id ? rattachee : f)));
      if (companyId) persist(() => sauvegarderFactureClient(companyId, rattachee));
    } else {
      const existante = facturesFournisseurs.find((f) => f.id === rattachement.existanteId);
      if (!existante) return;
      const r = rattacherAPennylane(commeFusionnableFournisseur(existante), document);
      const rattachee: FactureFournisseur = {
        ...existante,
        pennylaneId: r.pennylaneId,
        facture: r.facture,
        fournisseur: r.tiers,
        montant: r.montant,
        dateEcheance: r.dateEcheance,
        datePaiementPrevue: r.datePrevue,
        payee: r.payee,
        paidAt: existante.payee ? existante.paidAt : r.payee ? new Date().toISOString() : null,
      };
      setFacturesFournisseurs((prev) => prev.map((f) => (f.id === rattachee.id ? rattachee : f)));
      if (companyId) persist(() => sauvegarderFactureFournisseur(companyId, rattachee));
    }
  };

  const handleImporterSeparement = (sens: "client" | "fournisseur", rattachement: RattachementPropose) => {
    retirerProposition(sens, rattachement);
    if (sens === "client") handleImporterFactures([candidatVersFactureClient(rattachement.candidat)], []);
    else handleImporterFactures([], [candidatVersFactureFournisseur(rattachement.candidat)]);
  };

  // Fusion confirmée par l'utilisateur, avec ses choix (lib/doublonsFactures.ts::appliquerFusion).
  // L'écran ne change qu'une fois la fusion enregistrée : en cas d'échec, les factures sont relues
  // et la carte reste affichée avec l'erreur (rejet propagé au composant).
  const handleFusionner = async (sens: SensFacture, paire: PaireDoublon<FactureFusionnable>, proposition: PropositionFusion, choix: ChoixFusion) => {
    const resultat = appliquerFusion(paire.a, paire.b, proposition, choix);
    if (!resultat || !companyId) throw new Error("Fusion incomplète.");
    const decision: DecisionDoublon = { sens, cle: clePaire(paire.a.id, paire.b.id), decision: "fusion", pennylaneIdRetire: resultat.pennylaneIdRetire };
    // La référence garde son document (n°, tiers, montant, échéance) ; elle reçoit les réglages de
    // prévision repris. Payée : la date de paiement vient de la ligne qui la portait.
    const datePaiement = <T extends { payee: boolean; paidAt: string | null }>(ref: T, autre: T) => (ref.payee ? ref.paidAt : autre.payee ? autre.paidAt : null);
    const valeurs = { litigieuse: resultat.reference.litigieuse, payee: resultat.reference.payee };
    try {
      if (sens === "client") {
        const [ref, autre] = [facturesClients.find((f) => f.id === resultat.reference.id), facturesClients.find((f) => f.id === resultat.retiree.id)];
        if (!ref || !autre) throw new Error("Facture introuvable.");
        const reference: FactureClient = { ...ref, ...valeurs, dateEncaissementAnticipee: resultat.reference.datePrevue, paidAt: datePaiement(ref, autre) };
        await enregistrerFusion(companyId, "client", { avant: [ref, autre], reference, retiree: autre, pennylaneIdRetire: resultat.pennylaneIdRetire, choix: { ...choix } });
        setFacturesClients((prev) => prev.filter((f) => f.id !== autre.id).map((f) => (f.id === reference.id ? reference : f)));
      } else {
        const [ref, autre] = [facturesFournisseurs.find((f) => f.id === resultat.reference.id), facturesFournisseurs.find((f) => f.id === resultat.retiree.id)];
        if (!ref || !autre) throw new Error("Facture introuvable.");
        const reference: FactureFournisseur = {
          ...ref,
          ...valeurs,
          datePaiementPrevue: resultat.reference.datePrevue,
          paidAt: datePaiement(ref, autre),
          etagePnlManuel: resultat.reference.etagePnlManuel ?? null,
        };
        // Rapprochements avec les Charges fixes : ceux de la ligne retirée passent à la référence (pas
        // de lien orphelin « à revoir »), sauf si elle porte déjà une décision sur la même charge.
        const dejaSurReference = new Set(liensRapprochement.filter((l) => l.factureFournisseurId === reference.id).map((l) => l.chargeFixeId));
        const liensDeplaces = liensRapprochement
          .filter((l) => l.factureFournisseurId === autre.id && !dejaSurReference.has(l.chargeFixeId))
          .map((l) => ({ ...l, factureFournisseurId: reference.id }));
        await enregistrerFusion(
          companyId,
          "fournisseur",
          { avant: [ref, autre], reference, retiree: autre, pennylaneIdRetire: resultat.pennylaneIdRetire, choix: { ...choix } },
          async () => {
            for (const lien of liensDeplaces) await sauvegarderLienRapprochement(companyId, lien);
            await supprimerRefusSansIdentitePennylane([autre.id]);
            // Étage P&L choisi dans Futur : repris de la ligne retirée (ou tranché), jamais perdu.
            if ((reference.etagePnlManuel ?? null) !== (ref.etagePnlManuel ?? null)) {
              await affecterEtagePnlManuel("supplier_invoices", companyId, [reference.id], reference.etagePnlManuel ?? null);
            }
          }
        );
        const idsDeplaces = new Set(liensDeplaces.map((l) => l.id));
        setLiensRapprochement((prev) =>
          detacherFactures(
            prev.map((l) => (idsDeplaces.has(l.id) ? liensDeplaces.find((d) => d.id === l.id)! : l)),
            [autre.id]
          )
        );
        setFacturesFournisseurs((prev) => prev.filter((f) => f.id !== autre.id).map((f) => (f.id === reference.id ? reference : f)));
      }
      setDecisionsDoublons((prev) => [...prev.filter((d) => !(d.sens === sens && d.cle === decision.cle)), decision]);
    } catch (error) {
      console.error(`[doublons] fusion sens=${sens} code=${(error as { code?: string } | null)?.code ?? "inconnu"}`);
      // Une partie a pu être écrite : l'état réel est relu (rejouer la fusion la termine).
      const donnees = await chargerOuInitialiserDonnees(companyId).catch(() => null);
      if (donnees) {
        setFacturesClients(donnees.facturesClients);
        setFacturesFournisseurs(donnees.facturesFournisseurs);
      }
      throw error;
    }
  };

  // « Ce ne sont pas des doublons » : enregistré, la paire n'est plus proposée (rechargement compris).
  const handleIgnorerPaire = async (sens: SensFacture, paire: PaireDoublon<FactureFusionnable>) => {
    const decision: DecisionDoublon = { sens, cle: clePaire(paire.a.id, paire.b.id), decision: "distinct", pennylaneIdRetire: null };
    setDecisionsDoublons((prev) => [...prev, decision]);
    if (!companyId) return;
    try {
      await enregistrerPaireDistincte(companyId, sens, paire.a.id, paire.b.id);
    } catch (error) {
      setDecisionsDoublons((prev) => prev.filter((d) => d !== decision));
      throw error;
    }
  };

  const handleImporterChargesFixesDetectees = (nouvellesChargesFixes: ChargeFixe[]) => {
    if (nouvellesChargesFixes.length === 0) return;
    setChargesFixes((prev) => [...prev, ...nouvellesChargesFixes]);
    if (companyId) persist(() => importerChargesFixes(companyId, nouvellesChargesFixes));
  };

  const handleChangeChargeFixe = (id: string, patch: Partial<ChargeFixe>) => {
    setChargesFixes((prev) => {
      const courante = prev.find((c) => c.id === id);
      if (!courante) return prev;

      let patchApplique = patch;

      if (patch.modeMontant === "calcule" && courante.modeMontant === "fixe") {
        // Une charge déjà utilisée comme source ne peut pas devenir elle-même calculée
        // (empêche toute chaîne de dépendances à 2 niveaux).
        const dependantes = chargesUtilisantCommeSource("charge_fixe", id, prev);
        if (dependantes.length > 0) {
          window.alert(messageBlocageConversion(dependantes));
          return prev;
        }
      }

      if (patch.modeMontant === "fixe" && courante.modeMontant === "calcule") {
        // Passage Calculé -> Fixe : fige le montant calculé courant et retire la dépendance.
        const montantCourant = montantApercuChargeFixe(courante, prev, rentreesRegulieres);
        patchApplique = {
          ...patch,
          montant: montantCourant ?? courante.montant,
          tauxCalcul: null,
          sourceCalculId: null,
          sourceCalculType: null,
        };
      }

      const suivant = prev.map((c) => (c.id === id ? { ...c, ...patchApplique } : c));
      const charge = suivant.find((c) => c.id === id);
      if (companyId && charge) {
        persistDebounce(`chargeFixe:${id}`, () => sauvegarderChargeFixe(companyId, charge));
      }
      return suivant;
    });
  };

  const handleAddChargeFixe = () => {
    const charge: ChargeFixe = {
      id: crypto.randomUUID(),
      libelle: "",
      montant: 0,
      datePrevue: "",
      recurrence: "mensuel",
      dateFin: null,
      modeMontant: "fixe",
      tauxCalcul: null,
      sourceCalculId: null,
      sourceCalculType: null,
      aCouper: false,
    };
    setChargesFixes((prev) => [...prev, charge]);
    if (companyId) persist(() => sauvegarderChargeFixe(companyId, charge));
  };

  const handleRemoveChargeFixe = (id: string) => {
    const dependantes = chargesUtilisantCommeSource("charge_fixe", id, chargesFixes);
    if (dependantes.length > 0) {
      window.alert(messageBlocageSuppression(dependantes));
      return;
    }
    setChargesFixes((prev) => prev.filter((c) => c.id !== id));
    // Les rapprochements et la mémoire fournisseur d'une charge disparaissent avec elle (cascade en base).
    setLiensRapprochement((prev) => prev.filter((l) => l.chargeFixeId !== id));
    setMappingsFournisseurs((prev) => prev.filter((m) => m.chargeFixeId !== id));
    if (companyId) persist(() => supprimerChargeFixe(id));
  };

  const handleChangeAutreDepense = (id: string, patch: Partial<AutreDepense>) => {
    setAutresDepenses((prev) => {
      const suivant = prev.map((d) => (d.id === id ? { ...d, ...patch } : d));
      const depense = suivant.find((d) => d.id === id);
      if (companyId && depense) {
        persistDebounce(`autreDepense:${id}`, () => sauvegarderAutreDepense(companyId, depense));
      }
      return suivant;
    });
  };

  const handleAddAutreDepense = () => {
    const depense: AutreDepense = {
      id: crypto.randomUUID(),
      libelle: "",
      montant: 0,
      datePrevue: "",
      type: "certaine",
      facturee: false,
      payee: false,
    };
    setAutresDepenses((prev) => [...prev, depense]);
    if (companyId) persist(() => sauvegarderAutreDepense(companyId, depense));
  };

  const handleRemoveAutreDepense = (id: string) => {
    setAutresDepenses((prev) => prev.filter((d) => d.id !== id));
    if (companyId) persist(() => supprimerAutreDepense(id));
  };

  // Étage P&L (lib/futurPnl.ts) : une ligne (cellule du tableau) ou plusieurs (« Affecter un étage
  // P&L »). null = « Reprendre le classement automatique ». Seul le choix manuel est écrit ; aucun
  // autre champ, aucune autre ligne, ni la correspondance partagée, ni Pennylane.
  // L'affichage (et donc le groupe de la ligne) ne change qu'une fois l'enregistrement réussi ; en
  // cas d'échec, l'ancien classement reste en place et l'erreur s'affiche sous le tableau.
  const enregistrerEtage = async (table: TableDepense, ids: string[], etage: EtageDepense | null, appliquer: () => void) => {
    setErreursEtage((prev) => ({ ...prev, [table]: undefined }));
    if (!companyId) {
      appliquer();
      return;
    }
    try {
      await affecterEtagePnlManuel(table, companyId, ids, etage);
      appliquer();
    } catch (error) {
      console.error("Échec de l'enregistrement de l'étage P&L :", error);
      setErreursEtage((prev) => ({
        ...prev,
        [table]: "Classement non enregistré : l'étage précédent est conservé. Réessayez.",
      }));
    }
  };
  const appliquerEtage = <T extends { id: string; etagePnlManuel?: EtageDepense | null }>(
    liste: T[],
    ids: string[],
    etage: EtageDepense | null
  ): T[] => {
    const cibles = new Set(ids);
    return liste.map((x) => (cibles.has(x.id) ? { ...x, etagePnlManuel: etage } : x));
  };
  const handleChangeEtageFacturesFournisseurs = (ids: string[], etage: EtageDepense | null) =>
    void enregistrerEtage("supplier_invoices", ids, etage, () => setFacturesFournisseurs((prev) => appliquerEtage(prev, ids, etage)));
  const handleChangeEtageChargesFixes = (ids: string[], etage: EtageDepense | null) =>
    void enregistrerEtage("fixed_charges", ids, etage, () => setChargesFixes((prev) => appliquerEtage(prev, ids, etage)));
  const handleChangeEtageAutresDepenses = (ids: string[], etage: EtageDepense | null) =>
    void enregistrerEtage("other_expenses", ids, etage, () => setAutresDepenses((prev) => appliquerEtage(prev, ids, etage)));

  const handleChangeFinancement = (id: string, patch: Partial<Financement>) => {
    setFinancements((prev) => {
      const suivant = prev.map((f) => (f.id === id ? { ...f, ...patch } : f));
      const financement = suivant.find((f) => f.id === id);
      if (companyId && financement) {
        persistDebounce(`financement:${id}`, () => sauvegarderFinancement(companyId, financement));
      }
      return suivant;
    });
  };

  const handleAddFinancement = () => {
    const financement: Financement = {
      id: crypto.randomUUID(),
      libelle: "",
      montant: 0,
      dateEncaissementPrevue: "",
      verse: false,
    };
    setFinancements((prev) => [...prev, financement]);
    if (companyId) persist(() => sauvegarderFinancement(companyId, financement));
  };

  const handleRemoveFinancement = (id: string) => {
    setFinancements((prev) => prev.filter((f) => f.id !== id));
    if (companyId) persist(() => supprimerFinancement(id));
  };

  const handleChangeRentreeReguliere = (id: string, patch: Partial<RentreeReguliere>) => {
    setRentreesRegulieres((prev) => {
      const courante = prev.find((r) => r.id === id);
      if (!courante) return prev;

      let patchApplique = patch;

      if (patch.modeMontant === "saisonnalise" && courante.modeMontant === "fixe") {
        // Passage Fixe -> Saisonnalisé : répartition uniforme par défaut, pas de reprise
        // automatique d'un montant annuel (demandé explicitement à l'utilisateur). La fréquence
        // n'est pas imposée : la saisonnalité est toujours calculée au niveau mensuel en
        // interne, puis répartie sur les occurrences de la fréquence choisie (ponctuel/
        // quotidien/hebdomadaire/mensuel) par le moteur — voir lib/saisonnalite.ts.
        patchApplique = {
          ...patch,
          profilSaisonnalite: { montantAnnuel: 0, ponderationsMensuelles: repartitionUniforme() },
        };
      }

      if (patch.modeMontant === "fixe" && courante.modeMontant === "saisonnalise") {
        // Passage Saisonnalisé -> Fixe : fige le montant du mois calendaire courant.
        const montantCourant = montantOccurrenceRentreeReguliere(courante, new Date());
        patchApplique = {
          ...patch,
          montant: montantCourant ?? courante.montant,
          profilSaisonnalite: null,
        };
      }

      const suivant = prev.map((r) => (r.id === id ? { ...r, ...patchApplique } : r));
      const rentree = suivant.find((r) => r.id === id);
      if (companyId && rentree) {
        persistDebounce(`rentreeReguliere:${id}`, () => sauvegarderRentreeReguliere(companyId, rentree));
      }
      return suivant;
    });
  };

  const handleAddRentreeReguliere = () => {
    const rentree: RentreeReguliere = {
      id: crypto.randomUUID(),
      libelle: "",
      montant: 0,
      dateDebut: "",
      frequence: "mensuel",
      dateFin: null,
      modeMontant: "fixe",
      profilSaisonnalite: null,
    };
    setRentreesRegulieres((prev) => [...prev, rentree]);
    if (companyId) persist(() => sauvegarderRentreeReguliere(companyId, rentree));
  };

  const handleRemoveRentreeReguliere = (id: string) => {
    const dependantes = chargesUtilisantCommeSource("rentree_reguliere", id, chargesFixes);
    if (dependantes.length > 0) {
      window.alert(messageBlocageSuppression(dependantes));
      return;
    }
    setRentreesRegulieres((prev) => prev.filter((r) => r.id !== id));
    if (companyId) persist(() => supprimerRentreeReguliere(id));
  };

  const handleDeconnexion = () => {
    supabase!.auth.signOut();
  };

  if (supabaseConfigured && !sessionChargee) {
    return <main className="cockpit-chargement">Chargement…</main>;
  }

  if (supabaseConfigured && !session) {
    return <LoginForm />;
  }

  if (supabaseConfigured && etatAcces === "verification") {
    return <main className="cockpit-chargement">Vérification de votre accès…</main>;
  }

  if (supabaseConfigured && etatAcces === "refuse") {
    return <main className="cockpit-chargement">Redirection vers la page d&apos;abonnement…</main>;
  }

  if (supabaseConfigured && etatAcces === "erreur") {
    return (
      <main className="cockpit-chargement cockpit-erreur-acces">
        <p>Impossible de vérifier votre accès pour le moment. Veuillez réessayer.</p>
        <div className="cockpit-erreur-acces__actions">
          <button type="button" className="btn-add" onClick={() => setTentativeVerification((t) => t + 1)}>
            Réessayer
          </button>
          <button type="button" className="btn-secondaire" onClick={() => supabase!.auth.signOut()}>
            Se déconnecter
          </button>
        </div>
      </main>
    );
  }

  if (supabaseConfigured && etatAcces === "hors_offre" && session && offreHorsProjection) {
    return (
      <main className="cockpit">
        <EnTeteCockpit
          moduleActif="futur"
          compte={{ email: session.user.email, passeDisponible: modulePasseActif, onDeconnexion: handleDeconnexion }}
        />
        <OffreVerrouillee
          capacite="canViewForecast"
          fonctionnalite="La projection de trésorerie"
          offreActuelle={offreHorsProjection}
          lien={modulePasseActif ? { href: ROUTE_PASSE, libelle: "Ouvrir l'analyse des flux" } : undefined}
        />
      </main>
    );
  }

  // À partir d'ici, etatAcces === "autorise" (fail-closed : tout autre état est
  // déjà intercepté ci-dessus, jamais de cockpit sans vérification réussie).
  if (supabaseConfigured && !donneesChargees) {
    return <main className="cockpit-chargement">Chargement des données…</main>;
  }

  return (
    <main className="cockpit">
      {!supabaseConfigured && (
        <div className="bandeau-mode-local">
          Mode local — configurez Supabase (.env.local) pour sauvegarder les données.
        </div>
      )}
      <EnTeteCockpit
        moduleActif="futur"
        compte={
          supabaseConfigured && session
            ? { email: session.user.email, passeDisponible: modulePasseActif, onDeconnexion: handleDeconnexion }
            : undefined
        }
      />
      <div className="passe-onglets onglets-futur" role="tablist" aria-label="Vues du module Futur">
        <div className="passe-onglets__groupe" role="presentation">
          {(
            [
              { cle: "flux", libelle: "Flux de tréso" },
              { cle: "fiabilite", libelle: "Fiabilité de la projection" },
            ] as const
          ).map((onglet) => (
            <button
              key={onglet.cle}
              type="button"
              role="tab"
              aria-selected={ongletFutur === onglet.cle}
              className={`passe-onglet${ongletFutur === onglet.cle ? " passe-onglet--actif" : ""}`}
              onClick={() => setOngletFutur(onglet.cle)}
            >
              {onglet.libelle}
            </button>
          ))}
        </div>
      </div>
      {/* Les deux onglets restent montés (masqués par hidden) : saisies et états conservés. */}
      <div className="pilotage" hidden={ongletFutur !== "flux"}>
        <div className="pilotage__scroll">
          <Dashboard
            soldeInitial={soldeInitial}
            onChangeSoldeInitial={handleChangeSoldeInitial}
            dateReleve={dateReleve}
            onChangeDateReleve={handleChangeDateReleve}
            horizonJours={horizonJours}
            onChangeHorizonJours={handleChangeHorizonJours}
            resultat={resultat}
            onPointClickCourbe={handleClicCourbe}
          />
          <SyntheseMensuelle synthese={syntheseMensuelle} />
          <Cartouche
            titre="Futur"
            lignes={[
              { libelle: "Relevé du", valeur: formatDate(dateReleve) },
              { libelle: "Horizon", valeur: `${horizonJours} jours` },
              { libelle: "Montants", valeur: "TTC" },
              { libelle: "Édité le", valeur: formatDate(todayISO()) },
            ]}
          />
        </div>
      </div>
      <div className="cockpit__col--droite" hidden={ongletFutur !== "flux"}>
        {periodeFiltre && fluxPeriode && (
          <BandeauPeriodeFiltre
            dateClic={periodeFiltre.dateClic}
            debut={periodeFiltre.debut}
            fin={periodeFiltre.fin}
            resume={fluxPeriode.resume}
            onRevenir={handleRevenirVueGenerale}
          />
        )}
        <div className="barre-outils-recherche">
          <BarreRecherche valeur={recherche} onChange={setRecherche} />
          <div className="tri-controle">
            <label htmlFor="tri-select">Trier par</label>
            <select id="tri-select" value={tri} onChange={(e) => setTri(e.target.value as TriMode)}>
              <option value="date">Date la plus proche</option>
              <option value="montant">Montant le plus élevé</option>
            </select>
          </div>
          <button
            type="button"
            className="btn-secondaire btn-export"
            onClick={handleExporterExcel}
            disabled={exportEnCours}
          >
            {exportEnCours ? "Export…" : "Exporter vers Excel"} <IconTelechargement />
          </button>
        </div>
        {recherche && (
          <p className="recherche-resume">
            {totalResultatsRecherche === 0
              ? "Aucun résultat pour cette recherche"
              : `${totalResultatsRecherche} ligne(s) trouvée(s)`}
          </p>
        )}

        <SectionRepliable titre="Entrées" ouvertParDefaut>
          <DoublonsFactures
            sens="client"
            rattachements={rattachementsProposes.client}
            paires={doublonsClients}
            factureParId={(id) => {
              const f = facturesClients.find((x) => x.id === id);
              return f ? commeFusionnableClient(f) : undefined;
            }}
            onRattacher={(r) => handleRattacher("client", r)}
            onImporterSeparement={(r) => handleImporterSeparement("client", r)}
            onFusionner={(p, proposition, choix) => handleFusionner("client", p, proposition, choix)}
            onIgnorer={(p) => handleIgnorerPaire("client", p)}
          />
          <FacturesClientsTable
            factures={facturesClients}
            onChange={handleChangeFactureClient}
            onAdd={handleAddFactureClient}
            onRemove={handleRemoveFactureClient}
            recherche={recherche}
            tri={tri}
            filtrePeriode={fluxPeriode?.idsFacturesClients ?? null}
            pennylaneConnecte={pennylaneConnecte === true}
            onSynchroniserPennylane={handleClicSynchroniserPennylane}
            syncPennylaneEnCours={syncPennylaneEnCours}
            syncPennylaneResultat={syncPennylaneResultat}
            syncPennylaneErreur={syncPennylaneErreur}
          />
          <RentreesRegulieresTable
            rentrees={rentreesRegulieres}
            onChange={handleChangeRentreeReguliere}
            onAdd={handleAddRentreeReguliere}
            onRemove={handleRemoveRentreeReguliere}
            recherche={recherche}
            tri={tri}
            filtrePeriode={fluxPeriode?.occurrencesRentreesRegulieres ?? null}
            periodeFiltre={periodeFiltre}
          />
          <FinancementsTable
            financements={financements}
            onChange={handleChangeFinancement}
            onAdd={handleAddFinancement}
            onRemove={handleRemoveFinancement}
            recherche={recherche}
            tri={tri}
            filtrePeriode={fluxPeriode?.idsFinancements ?? null}
          />
        </SectionRepliable>

        <SectionRepliable titre="Sorties" ouvertParDefaut>
          <DoublonsFactures
            sens="fournisseur"
            rattachements={rattachementsProposes.fournisseur}
            paires={doublonsFournisseurs}
            factureParId={(id) => {
              const f = facturesFournisseurs.find((x) => x.id === id);
              return f ? commeFusionnableFournisseur(f) : undefined;
            }}
            onRattacher={(r) => handleRattacher("fournisseur", r)}
            onImporterSeparement={(r) => handleImporterSeparement("fournisseur", r)}
            onFusionner={(p, proposition, choix) => handleFusionner("fournisseur", p, proposition, choix)}
            onIgnorer={(p) => handleIgnorerPaire("fournisseur", p)}
          />
          <RapprochementChargesFixes
            propositions={propositionsRapprochement}
            aRevoir={resolutionRapprochement.aRevoir}
            factures={facturesFournisseurs}
            charges={chargesFixes}
            onConfirmer={handleConfirmerRapprochement}
            onRefuser={handleRefuserRapprochement}
            onDissocier={handleDissocierRapprochement}
            onLaisserRemplacee={handleLaisserRemplacee}
            factureManuelle={facturesFournisseurs.find((f) => f.id === factureManuelleId) ?? null}
            occurrencesManuelles={(chargeFixeId) => {
              const facture = facturesFournisseurs.find((f) => f.id === factureManuelleId);
              const charge = chargesFixes.find((c) => c.id === chargeFixeId);
              return facture && charge ? occurrencesRapprochables(facture, charge, parametresRapprochement) : [];
            }}
            onAnnulerManuel={() => setFactureManuelleId(null)}
          />
          <FacturesFournisseursTable
            factures={facturesFournisseurs}
            onChange={handleChangeFactureFournisseur}
            onAdd={handleAddFactureFournisseur}
            onRemove={handleRemoveFactureFournisseur}
            recherche={recherche}
            tri={tri}
            filtrePeriode={fluxPeriode?.idsFacturesFournisseurs ?? null}
            pennylaneConnecte={pennylaneConnecte === true}
            onSynchroniserPennylane={handleClicSynchroniserPennylane}
            syncPennylaneEnCours={syncPennylaneEnCours}
            syncPennylaneResultat={syncPennylaneResultat}
            syncPennylaneErreur={syncPennylaneErreur}
            correspondance={correspondancePnl}
            onChangeEtage={handleChangeEtageFacturesFournisseurs}
            erreurEtage={erreursEtage.supplier_invoices}
            rapprochements={rapprochementsParFacture}
            onRapprocher={(id) => {
              setFactureManuelleId(id);
              // Le bloc de rapprochement manuel s'affiche au-dessus du tableau : on l'amène à l'écran.
              setTimeout(() => document.getElementById("rapprochement-charges-fixes")?.scrollIntoView({ behavior: "smooth", block: "center" }), 0);
            }}
            onDissocier={handleDissocierRapprochement}
          />
          <ChargesFixesTable
            charges={chargesFixes}
            rentreesRegulieres={rentreesRegulieres}
            onChange={handleChangeChargeFixe}
            onAdd={handleAddChargeFixe}
            onRemove={handleRemoveChargeFixe}
            recherche={recherche}
            tri={tri}
            filtrePeriode={fluxPeriode?.occurrencesChargesFixes ?? null}
            periodeFiltre={periodeFiltre}
            correspondance={correspondancePnl}
            onChangeEtage={handleChangeEtageChargesFixes}
            erreurEtage={erreursEtage.fixed_charges}
          />
          <AutresDepensesTable
            depenses={autresDepenses}
            onChange={handleChangeAutreDepense}
            onAdd={handleAddAutreDepense}
            onRemove={handleRemoveAutreDepense}
            recherche={recherche}
            tri={tri}
            filtrePeriode={fluxPeriode?.idsAutresDepenses ?? null}
            correspondance={correspondancePnl}
            onChangeEtage={handleChangeEtageAutresDepenses}
            erreurEtage={erreursEtage.other_expenses}
          />
        </SectionRepliable>

        <SectionRepliable titre="Identifier mes charges fixes" ouvertParDefaut={false}>
          <ImportHistoriqueBancaire
            onValider={handleImporterChargesFixesDetectees}
            pennylaneConnecte={pennylaneConnecte === true}
            accessToken={session?.access_token ?? null}
          />
        </SectionRepliable>


        <SectionRepliable titre="Import de factures" ouvertParDefaut={false}>
          <ImportFactures
            onImporter={handleImporterFactures}
            pennylaneConnecte={pennylaneConnecte === true}
            onSynchroniserPennylane={handleClicSynchroniserPennylane}
            syncPennylaneEnCours={syncPennylaneEnCours}
            syncPennylaneResultat={syncPennylaneResultat}
            syncPennylaneErreur={syncPennylaneErreur}
          />
        </SectionRepliable>

      </div>

      {/* Fiabilité de la projection. Futur seul : « Vérifier mes données » et l'ancien Contrôle
          mensuel. Passé + Futur : le contrôle prévu / réalisé le remplace (droits revérifiés côté
          serveur par /api/futur/fiabilite). */}
      <section className="onglet-fiabilite" hidden={ongletFutur !== "fiabilite"} aria-label="Fiabilité de la projection">
        <SectionRepliable titre="Vérifier mes données" ouvertParDefaut>
          <VerifierMesDonnees
            facturesClients={facturesClients}
            facturesFournisseurs={facturesFournisseurs}
            autresDepenses={autresDepenses}
            financements={financements}
            onChangeFactureClient={handleChangeFactureClient}
            onChangeFactureFournisseur={handleChangeFactureFournisseur}
            onChangeAutreDepense={handleChangeAutreDepense}
            onChangeFinancement={handleChangeFinancement}
            pennylaneConnecte={pennylaneConnecte === true}
            accessToken={session?.access_token ?? null}
          />
        </SectionRepliable>
        {modulePasseActif ? (
          <SectionRepliable titre="Contrôle prévu / réalisé" ouvertParDefaut>
            <FiabiliteProjection accessToken={session?.access_token ?? null} actif={ongletFutur === "fiabilite"} />
          </SectionRepliable>
        ) : (
          <SectionRepliable titre="Contrôle mensuel" ouvertParDefaut>
            <ControleMensuel controle={controleMensuel} />
          </SectionRepliable>
        )}
      </section>
    </main>
  );
}
