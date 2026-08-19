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

const ImportFactures = dynamic(() => import("@/components/ImportFactures"), { ssr: false });
import { calculerProjectionCash } from "@/lib/cash-engine";
import { estMasqueeApresPaiement, todayISO } from "@/lib/dates";
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
  importerFacturesClients,
  importerFacturesFournisseurs,
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
      {supabaseConfigured && session && (
        <div className="barre-utilisateur">
          <span>{session.user.email}</span>
          <div className="barre-utilisateur__actions">
            <Link href="/account/billing" className="btn-secondaire">
              Abonnement
            </Link>
            <button type="button" className="btn-deconnexion" onClick={handleDeconnexion}>
              Se déconnecter
            </button>
          </div>
        </div>
      )}
      <div className="cockpit__col cockpit__col--gauche">
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
      <div className="cockpit__col cockpit__col--droite">
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

        <SectionRepliable titre="Import de factures" ouvertParDefaut={false}>
          <ImportFactures onImporter={handleImporterFactures} />
        </SectionRepliable>

        <SectionRepliable titre="Contrôle mensuel" ouvertParDefaut={false}>
          <ControleMensuel controle={controleMensuel} />
        </SectionRepliable>
      </div>
    </main>
  );
}
