"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import dynamic from "next/dynamic";
import { useRouter } from "next/navigation";
import Link from "next/link";
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
import LoginForm from "@/components/LoginForm";
import IconTelechargement from "@/components/IconTelechargement";

const ImportFactures = dynamic(() => import("@/components/ImportFactures"), { ssr: false });
const ImportHistoriqueBancaire = dynamic(() => import("@/components/ImportHistoriqueBancaire"), { ssr: false });
const VerifierMesDonnees = dynamic(() => import("@/components/VerifierMesDonnees"), { ssr: false });
import {
  calculerSynchronisation,
  candidatVersFactureClient,
  candidatVersFactureFournisseur,
  ResultatSyncPennylane,
} from "@/lib/pennylaneInvoiceAdapter";
import { calculerProjectionCash } from "@/lib/cash-engine";
import { estMasqueeApresPaiement, todayISO } from "@/lib/dates";
import { formatDate } from "@/lib/format";
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
  RentreeReguliere,
  TriMode,
} from "@/lib/types";
import { supabase, supabaseConfigured } from "@/lib/supabaseClient";
import { getOrCreateCompanyForBilling } from "@/lib/billing";
import {
  chargerOuInitialiserDonnees,
  sauvegarderAutreDepense,
  sauvegarderChargeFixe,
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
  supprimerFinancement,
  supprimerRentreeReguliere,
} from "@/lib/supabaseRepository";

const DELAI_DEBOUNCE_MS = 600;

function persist(action: () => Promise<void>) {
  action().catch((error) => console.error("Échec de la sauvegarde Supabase :", error));
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
  const [etatAcces, setEtatAcces] = useState<"verification" | "autorise" | "refuse" | "erreur">(
    !supabaseConfigured ? "autorise" : "verification"
  );
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
  const [recherche, setRecherche] = useState("");
  const [tri, setTri] = useState<TriMode>("date");
  const [dateClicCourbe, setDateClicCourbe] = useState<string | null>(null);
  const [exportEnCours, setExportEnCours] = useState(false);

  const dateDepart = dateReleve;

  // Résumé global de la recherche : purement pour l'affichage (compteur / message
  // "aucun résultat"), totalement indépendant du calcul de trésorerie ci-dessous.
  const totalResultatsRecherche = useMemo(() => {
    if (!recherche) return null;
    const facturesClientsActives = facturesClients.filter((f) => !estMasqueeApresPaiement(f.payee, f.paidAt));
    const facturesFournisseursActives = facturesFournisseurs.filter(
      (f) => !estMasqueeApresPaiement(f.payee, f.paidAt)
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

  useEffect(() => {
    if (!supabaseConfigured) return;

    if (!session) {
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
      setDonneesChargees(true);
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
  }, [session, router, tentativeVerification]);

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
      }),
    [facturesClients, facturesFournisseurs, chargesFixes, autresDepenses, financements, rentreesRegulieres]
  );

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
    if (companyId) persist(() => supprimerFactureFournisseur(id));
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
    idsFournisseursAMettreAJourPayee: string[]
  ) => {
    if (nouvellesFacturesClients.length > 0) {
      setFacturesClients((prev) => [...prev, ...nouvellesFacturesClients]);
      if (companyId) persist(() => importerFacturesClients(companyId, nouvellesFacturesClients));
    }
    if (nouvellesFacturesFournisseurs.length > 0) {
      setFacturesFournisseurs((prev) => [...prev, ...nouvellesFacturesFournisseurs]);
      if (companyId) persist(() => importerFacturesFournisseurs(companyId, nouvellesFacturesFournisseurs));
    }

    if (idsClientsAMettreAJourPayee.length > 0) {
      const idsAMettreAJour = new Set(idsClientsAMettreAJourPayee);
      const maintenant = new Date().toISOString();
      setFacturesClients((prev) =>
        prev.map((f) => (idsAMettreAJour.has(f.id) ? { ...f, payee: true, paidAt: maintenant } : f))
      );
      persist(() => marquerFacturesClientsPayees(idsClientsAMettreAJourPayee));
    }
    if (idsFournisseursAMettreAJourPayee.length > 0) {
      const idsAMettreAJour = new Set(idsFournisseursAMettreAJourPayee);
      const maintenant = new Date().toISOString();
      setFacturesFournisseurs((prev) =>
        prev.map((f) => (idsAMettreAJour.has(f.id) ? { ...f, payee: true, paidAt: maintenant } : f))
      );
      persist(() => marquerFacturesFournisseursPayees(idsFournisseursAMettreAJourPayee));
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
      }));
      const facturesFournisseursExistantesPourSync = facturesFournisseurs.map((f) => ({
        id: f.id,
        pennylaneId: f.pennylaneId,
        payee: f.payee,
      }));

      let nombreClientsAjoutes = 0;
      let nombreFournisseursAjoutes = 0;
      let idsClientsAMettreAJourPayee: string[] = [];
      let idsFournisseursAMettreAJourPayee: string[] = [];
      let nouvellesFacturesClients: FactureClient[] = [];
      let nouvellesFacturesFournisseurs: FactureFournisseur[] = [];

      if (data.clientCandidates) {
        const { aInserer, idsAMettreAJourPayee } = calculerSynchronisation(
          data.clientCandidates,
          facturesClientsExistantesPourSync
        );
        nouvellesFacturesClients = aInserer.map(candidatVersFactureClient);
        idsClientsAMettreAJourPayee = idsAMettreAJourPayee;
        nombreClientsAjoutes = nouvellesFacturesClients.length;
      }

      if (data.fournisseurCandidates) {
        const { aInserer, idsAMettreAJourPayee } = calculerSynchronisation(
          data.fournisseurCandidates,
          facturesFournisseursExistantesPourSync
        );
        nouvellesFacturesFournisseurs = aInserer.map(candidatVersFactureFournisseur);
        idsFournisseursAMettreAJourPayee = idsAMettreAJourPayee;
        nombreFournisseursAjoutes = nouvellesFacturesFournisseurs.length;
      }

      handleSynchroniserPennylaneFactures(
        nouvellesFacturesClients,
        nouvellesFacturesFournisseurs,
        idsClientsAMettreAJourPayee,
        idsFournisseursAMettreAJourPayee
      );

      setSyncPennylaneResultat({
        nombreClientsAnalysees: Array.isArray(data.clientCandidates) ? data.clientCandidates.length : 0,
        nombreFournisseursAnalysees: Array.isArray(data.fournisseurCandidates) ? data.fournisseurCandidates.length : 0,
        nombreClientsAjoutes,
        nombreFournisseursAjoutes,
        nombreMarquesPayees: idsClientsAMettreAJourPayee.length + idsFournisseursAMettreAJourPayee.length,
        erreurClients: data.erreurClients ?? null,
        erreurFournisseurs: data.erreurFournisseurs ?? null,
      });
    } catch {
      setSyncPennylaneErreur("Pennylane est temporairement indisponible. Réessayez.");
    } finally {
      setSyncPennylaneEnCours(false);
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
      <header className="page-intro">
        <div className="page-intro__texte">
          <p className="eyebrow">Novanta</p>
          <h1 className="page-intro__titre">Trésorerie</h1>
          <p className="page-intro__sous-titre">
            Vue consolidée sur {horizonJours} jours · relevé au {formatDate(dateReleve)}
          </p>
        </div>
        {supabaseConfigured && session && (
          <div className="page-intro__actions">
            <span className="page-intro__email">{session.user.email}</span>
            <Link href="/account/billing" className="btn-secondaire">
              Abonnement
            </Link>
            <Link href="/account/integrations" className="btn-secondaire">
              Intégrations
            </Link>
            <button type="button" className="btn-deconnexion" onClick={handleDeconnexion}>
              Se déconnecter
            </button>
          </div>
        )}
      </header>
      <div className="pilotage">
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
      </div>
      <div className="cockpit__col--droite">
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
          />
          <AutresDepensesTable
            depenses={autresDepenses}
            onChange={handleChangeAutreDepense}
            onAdd={handleAddAutreDepense}
            onRemove={handleRemoveAutreDepense}
            recherche={recherche}
            tri={tri}
            filtrePeriode={fluxPeriode?.idsAutresDepenses ?? null}
          />
        </SectionRepliable>

        <SectionRepliable titre="Identifier mes charges fixes" ouvertParDefaut={false}>
          <ImportHistoriqueBancaire
            onValider={handleImporterChargesFixesDetectees}
            pennylaneConnecte={pennylaneConnecte === true}
            accessToken={session?.access_token ?? null}
          />
        </SectionRepliable>

        <SectionRepliable titre="Vérifier mes données" ouvertParDefaut={false}>
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

        <SectionRepliable titre="Contrôle mensuel" ouvertParDefaut={false}>
          <ControleMensuel controle={controleMensuel} />
        </SectionRepliable>
      </div>
    </main>
  );
}
