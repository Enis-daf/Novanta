"use client";

import { useEffect, useMemo, useState } from "react";
import type { Session } from "@supabase/supabase-js";
import Dashboard from "@/components/Dashboard";
import FacturesClientsTable from "@/components/FacturesClientsTable";
import FacturesFournisseursTable from "@/components/FacturesFournisseursTable";
import ChargesFixesTable from "@/components/ChargesFixesTable";
import AutresDepensesTable from "@/components/AutresDepensesTable";
import FinancementsTable from "@/components/FinancementsTable";
import LoginForm from "@/components/LoginForm";
import { calculerProjectionCash } from "@/lib/cash-engine";
import { todayISO } from "@/lib/dates";
import {
  SOLDE_BANCAIRE_INITIAL,
  mockAutresDepenses,
  mockChargesFixes,
  mockFacturesClients,
  mockFacturesFournisseurs,
  mockFinancements,
} from "@/lib/mockData";
import { AutreDepense, ChargeFixe, FactureClient, FactureFournisseur, Financement } from "@/lib/types";
import { supabase, supabaseConfigured } from "@/lib/supabaseClient";
import {
  chargerOuInitialiserDonnees,
  getOrCreateCompanyForUser,
  sauvegarderAutreDepense,
  sauvegarderChargeFixe,
  sauvegarderFactureClient,
  sauvegarderFactureFournisseur,
  sauvegarderFinancement,
  sauvegarderSoldeInitial,
  supprimerAutreDepense,
  supprimerChargeFixe,
  supprimerFinancement,
} from "@/lib/supabaseRepository";

function persist(action: () => Promise<void>) {
  action().catch((error) => console.error("Échec de la sauvegarde Supabase :", error));
}

export default function Home() {
  const [session, setSession] = useState<Session | null>(null);
  const [sessionChargee, setSessionChargee] = useState(!supabaseConfigured);
  const [companyId, setCompanyId] = useState<string | null>(null);
  const [donneesChargees, setDonneesChargees] = useState(!supabaseConfigured);

  const [soldeInitial, setSoldeInitial] = useState(SOLDE_BANCAIRE_INITIAL);
  const [facturesClients, setFacturesClients] = useState<FactureClient[]>(mockFacturesClients);
  const [facturesFournisseurs, setFacturesFournisseurs] =
    useState<FactureFournisseur[]>(mockFacturesFournisseurs);
  const [chargesFixes, setChargesFixes] = useState<ChargeFixe[]>(mockChargesFixes);
  const [autresDepenses, setAutresDepenses] = useState<AutreDepense[]>(mockAutresDepenses);
  const [financements, setFinancements] = useState<Financement[]>(mockFinancements);

  const dateDepart = useMemo(() => todayISO(), []);

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
      setDonneesChargees(false);
      return;
    }

    let annule = false;
    setDonneesChargees(false);

    (async () => {
      const id = await getOrCreateCompanyForUser(session.user.id);
      const donnees = await chargerOuInitialiserDonnees(id);
      if (annule) return;
      setCompanyId(id);
      setSoldeInitial(donnees.soldeInitial);
      setFacturesClients(donnees.facturesClients);
      setFacturesFournisseurs(donnees.facturesFournisseurs);
      setChargesFixes(donnees.chargesFixes);
      setAutresDepenses(donnees.autresDepenses);
      setFinancements(donnees.financements);
      setDonneesChargees(true);
    })().catch((error) => {
      console.error("Échec du chargement Supabase :", error);
      setDonneesChargees(true);
    });

    return () => {
      annule = true;
    };
  }, [session]);

  const resultat = useMemo(
    () =>
      calculerProjectionCash({
        soldeInitial,
        facturesClients,
        facturesFournisseurs,
        chargesFixes,
        autresDepenses,
        financements,
        dateDepart,
      }),
    [soldeInitial, facturesClients, facturesFournisseurs, chargesFixes, autresDepenses, financements, dateDepart]
  );

  const handleChangeSoldeInitial = (valeur: number) => {
    setSoldeInitial(valeur);
    if (companyId) persist(() => sauvegarderSoldeInitial(companyId, valeur));
  };

  const handleChangeFactureClient = (id: string, patch: Partial<FactureClient>) => {
    setFacturesClients((prev) => {
      const suivant = prev.map((f) => (f.id === id ? { ...f, ...patch } : f));
      const facture = suivant.find((f) => f.id === id);
      if (companyId && facture) persist(() => sauvegarderFactureClient(companyId, facture));
      return suivant;
    });
  };

  const handleChangeFactureFournisseur = (id: string, patch: Partial<FactureFournisseur>) => {
    setFacturesFournisseurs((prev) => {
      const suivant = prev.map((f) => (f.id === id ? { ...f, ...patch } : f));
      const facture = suivant.find((f) => f.id === id);
      if (companyId && facture) persist(() => sauvegarderFactureFournisseur(companyId, facture));
      return suivant;
    });
  };

  const handleChangeChargeFixe = (id: string, patch: Partial<ChargeFixe>) => {
    setChargesFixes((prev) => {
      const suivant = prev.map((c) => (c.id === id ? { ...c, ...patch } : c));
      const charge = suivant.find((c) => c.id === id);
      if (companyId && charge) persist(() => sauvegarderChargeFixe(companyId, charge));
      return suivant;
    });
  };

  const handleAddChargeFixe = () => {
    const charge: ChargeFixe = {
      id: crypto.randomUUID(),
      libelle: "",
      montant: 0,
      datePrevue: dateDepart,
      recurrence: "mensuelle",
    };
    setChargesFixes((prev) => [...prev, charge]);
    if (companyId) persist(() => sauvegarderChargeFixe(companyId, charge));
  };

  const handleRemoveChargeFixe = (id: string) => {
    setChargesFixes((prev) => prev.filter((c) => c.id !== id));
    if (companyId) persist(() => supprimerChargeFixe(id));
  };

  const handleChangeAutreDepense = (id: string, patch: Partial<AutreDepense>) => {
    setAutresDepenses((prev) => {
      const suivant = prev.map((d) => (d.id === id ? { ...d, ...patch } : d));
      const depense = suivant.find((d) => d.id === id);
      if (companyId && depense) persist(() => sauvegarderAutreDepense(companyId, depense));
      return suivant;
    });
  };

  const handleAddAutreDepense = () => {
    const depense: AutreDepense = {
      id: crypto.randomUUID(),
      libelle: "",
      montant: 0,
      datePrevue: dateDepart,
      type: "certaine",
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
      if (companyId && financement) persist(() => sauvegarderFinancement(companyId, financement));
      return suivant;
    });
  };

  const handleAddFinancement = () => {
    const financement: Financement = {
      id: crypto.randomUUID(),
      libelle: "",
      montant: 0,
      dateEncaissementPrevue: dateDepart,
    };
    setFinancements((prev) => [...prev, financement]);
    if (companyId) persist(() => sauvegarderFinancement(companyId, financement));
  };

  const handleRemoveFinancement = (id: string) => {
    setFinancements((prev) => prev.filter((f) => f.id !== id));
    if (companyId) persist(() => supprimerFinancement(id));
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
          <button type="button" className="btn-deconnexion" onClick={handleDeconnexion}>
            Se déconnecter
          </button>
        </div>
      )}
      <div className="cockpit__col cockpit__col--gauche">
        <Dashboard
          soldeInitial={soldeInitial}
          onChangeSoldeInitial={handleChangeSoldeInitial}
          resultat={resultat}
        />
      </div>
      <div className="cockpit__col cockpit__col--droite">
        <FacturesClientsTable factures={facturesClients} onChange={handleChangeFactureClient} />
        <FacturesFournisseursTable
          factures={facturesFournisseurs}
          onChange={handleChangeFactureFournisseur}
        />
        <ChargesFixesTable
          charges={chargesFixes}
          onChange={handleChangeChargeFixe}
          onAdd={handleAddChargeFixe}
          onRemove={handleRemoveChargeFixe}
        />
        <AutresDepensesTable
          depenses={autresDepenses}
          onChange={handleChangeAutreDepense}
          onAdd={handleAddAutreDepense}
          onRemove={handleRemoveAutreDepense}
        />
        <FinancementsTable
          financements={financements}
          onChange={handleChangeFinancement}
          onAdd={handleAddFinancement}
          onRemove={handleRemoveFinancement}
        />
      </div>
    </main>
  );
}
