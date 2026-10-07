"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import DateField from "./DateField";
import PasseMappingTable from "./PasseMappingTable";
import { supabase } from "@/lib/supabaseClient";
import { formatDateCourte, todayISO } from "@/lib/dates";
import { formatMontant } from "@/lib/format";
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
  periodeAnneeCivile,
  periodeValide,
  resoudreAxeAnalytique,
  transactionsCategorisees,
  trierParDateDecroissante,
} from "@/lib/pastTransactions";
import {
  compterAMapper,
  EtagePnl,
  FiltreMapping,
  lignesMapping,
  MappingCategorie,
} from "@/lib/pastCategoryMapping";
import {
  chargerAxeConfigure,
  chargerAxesAnalytiques,
  chargerMappingsCategories,
  chargerPastTransactions,
  sauvegarderAxeConfigure,
  sauvegarderEtageCategorie,
} from "@/lib/pastTransactionsRepository";

interface PasseTransactionsProps {
  organizationId: string;
  accessToken: string;
}

const LIGNES_PAR_PAGE = 50;
const formatNombre = new Intl.NumberFormat("fr-FR");

function pluriel(nombre: number, singulier: string, plurielTexte: string): string {
  return `${formatNombre.format(nombre)} ${nombre > 1 ? plurielTexte : singulier}`;
}

// Tableau des transactions du module Passé. Lit uniquement past_transactions (jamais Pennylane
// directement) : la source d'une transaction n'a aucune incidence sur l'affichage.
export default function PasseTransactions({ organizationId, accessToken }: PasseTransactionsProps) {
  const router = useRouter();
  const [periode, setPeriode] = useState<Periode>(() => periodeAnneeCivile(todayISO()));
  // Transactions telles que stockées (avec toutes leurs affectations analytiques) ; la catégorie
  // affichée en est dérivée plus bas, selon l'axe analytique retenu.
  const [stockees, setStockees] = useState<PastTransactionStockee[]>([]);
  const [axes, setAxes] = useState<AxeAnalytique[]>([]);
  const [axeConfigure, setAxeConfigure] = useState<string | null>(null);
  const [erreurAxe, setErreurAxe] = useState<string | null>(null);
  // Correspondance catégorie -> étage P&L : indépendante de la période, toujours accessible.
  const [mappings, setMappings] = useState<MappingCategorie[]>([]);
  const [vue, setVue] = useState<"transactions" | "mapping">("transactions");
  const [filtreMapping, setFiltreMapping] = useState<FiltreMapping>("toutes");
  const [erreurMapping, setErreurMapping] = useState<string | null>(null);
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
    ])
      .then(([lignes, axesConnus, axeChoisi, mappingsConnus]) => {
        if (annule) return;
        setStockees(trierParDateDecroissante(lignes));
        setAxes(axesConnus);
        setAxeConfigure(axeChoisi);
        setMappings(mappingsConnus);
        setChargement(false);
      })
      .catch((error) => {
        if (annule) return;
        console.error("Échec du chargement des transactions du module Passé :", error);
        setStockees([]);
        setErreurChargement("Impossible de charger les transactions pour le moment.");
        setChargement(false);
      });
    return () => {
      annule = true;
    };
  }, [organizationId, periode, periodeOk, rechargement]);

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

  const voirCategoriesAMapper = () => {
    setVue("mapping");
    setFiltreMapping("a_mapper");
  };

  const nombrePages = Math.max(1, Math.ceil(transactionsFiltrees.length / LIGNES_PAR_PAGE));
  const pageCourante = Math.min(page, nombrePages - 1);
  const lignesPage = transactionsFiltrees.slice(pageCourante * LIGNES_PAR_PAGE, (pageCourante + 1) * LIGNES_PAR_PAGE);

  const changerPeriode = (patch: Partial<Periode>) => {
    setPeriode((prev) => ({ ...prev, ...patch }));
    setPage(0);
    setSyncMessage(null);
    setSyncErreur(null);
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

  return (
    <section className="passe">
      <div className="passe-controles">
        <div className="passe-controle">
          <span className="passe-controle__label">Période</span>
          <DateField value={periode.debut} onChange={(v) => changerPeriode({ debut: v })} effacable={false} />
          <span className="passe-controle__separateur">→</span>
          <DateField value={periode.fin} onChange={(v) => changerPeriode({ fin: v })} effacable={false} />
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

      {syncErreur && <p className="passe-message passe-message--erreur">{syncErreur}</p>}
      {syncMessage && <p className="passe-message">{syncMessage}</p>}
      {erreurAxe && <p className="passe-message passe-message--erreur">{erreurAxe}</p>}
      {erreurMapping && <p className="passe-message passe-message--erreur">{erreurMapping}</p>}

      <div className="passe-onglets" role="tablist">
        <button
          type="button"
          role="tab"
          aria-selected={vue === "transactions"}
          className={`passe-onglet${vue === "transactions" ? " passe-onglet--actif" : ""}`}
          onClick={() => setVue("transactions")}
        >
          Transactions
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={vue === "mapping"}
          className={`passe-onglet${vue === "mapping" ? " passe-onglet--actif" : ""}`}
          onClick={() => setVue("mapping")}
        >
          Correspondance P&amp;L
          {nombreAMapper > 0 && <span className="passe-onglet__pastille">{nombreAMapper}</span>}
        </button>
      </div>

      {!periodeOk ? (
        <p className="passe-message passe-message--erreur">
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
                <button type="button" className="passe-a-mapper" onClick={voirCategoriesAMapper}>
                  {pluriel(nombreAMapper, "catégorie à mapper", "catégories à mapper")} →
                </button>
              )}
            </div>
          )}

          {axeAConfigurer ? null : vue === "mapping" ? (
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
