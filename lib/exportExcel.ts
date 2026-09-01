import ExcelJS from "exceljs";
import { AutreDepense, ChargeFixe, FactureClient, FactureFournisseur, Financement, HorizonJours, RentreeReguliere, TriMode } from "./types";
import { estEnRetard, estMasqueeApresPaiement, parseDateISO, todayISO, trierParDate, trierParMontant } from "./dates";
import {
  filtrerAutresDepenses,
  filtrerChargesFixes,
  filtrerFacturesClients,
  filtrerFacturesFournisseurs,
  filtrerFinancements,
  filtrerRentreesRegulieres,
} from "./recherche";
import { OccurrencesParId, PeriodeFiltre } from "./periodeFiltre";
import { ResultatProjectionCash } from "./cash-engine";
import { ResultatSyntheseMensuelle } from "./syntheseMensuelle";
import { detailChargeFixeSurPeriode, libelleSourceCalcul, montantApercuChargeFixe } from "./montantCalcule";
import { etatTotalPonderations, montantOccurrenceRentreeReguliere, montantRentreeReguliereSurPeriode, totalPonderations } from "./saisonnalite";

// Ce module RECOMPOSE, pour chaque catégorie, exactement la même chaîne filtre → recherche →
// tri que le tableau correspondant (voir xxxTriees dans chaque composant Table). Il réutilise
// les mêmes fonctions pures (filtrerXxx, trierParXxx, estMasqueeApresPaiement, estEnRetard,
// montantApercuChargeFixe, detailChargeFixeSurPeriode, montantRentreeReguliereSurPeriode) —
// aucune logique de filtrage n'est réécrite ici, seul l'ORDRE de composition est dupliqué par
// catégorie. Si un tableau change cet ordre, ce module doit être mis à jour en miroir.

const FMT_MONTANT = '#,##0" €"';
const FMT_DATE = "dd/mm/yyyy";
const FMT_POURCENTAGE = '0.00"%"';

const LABELS_RECURRENCE_CHARGE: Record<ChargeFixe["recurrence"], string> = {
  ponctuel: "Ponctuelle",
  quotidien: "Quotidienne",
  hebdomadaire: "Hebdomadaire",
  mensuel: "Mensuelle",
};

const LABELS_FREQUENCE_RENTREE: Record<RentreeReguliere["frequence"], string> = {
  ponctuel: "Ponctuel",
  quotidien: "Quotidien",
  hebdomadaire: "Hebdomadaire",
  mensuel: "Mensuel",
};

const LABELS_TYPE_DEPENSE: Record<AutreDepense["type"], string> = {
  certaine: "Certaine",
  probable: "Probable",
};

const NOMS_MOIS = [
  "Janvier",
  "Février",
  "Mars",
  "Avril",
  "Mai",
  "Juin",
  "Juillet",
  "Août",
  "Septembre",
  "Octobre",
  "Novembre",
  "Décembre",
];

function ouiNon(valeur: boolean): string {
  return valeur ? "Oui" : "Non";
}

function dateOuNull(iso: string | null | undefined): Date | null {
  if (!iso) return null;
  return parseDateISO(iso);
}

export interface FiltresParCategorie {
  facturesClients: OccurrencesParId | null;
  facturesFournisseurs: OccurrencesParId | null;
  chargesFixes: OccurrencesParId | null;
  autresDepenses: OccurrencesParId | null;
  financements: OccurrencesParId | null;
  rentreesRegulieres: OccurrencesParId | null;
}

export interface ParametresExportExcel {
  recherche: string;
  tri: TriMode;
  soldeInitial: number;
  dateReleve: string;
  horizonJours: HorizonJours;
  resultat: ResultatProjectionCash;
  syntheseMensuelle: ResultatSyntheseMensuelle;
  facturesClients: FactureClient[];
  facturesFournisseurs: FactureFournisseur[];
  chargesFixes: ChargeFixe[];
  autresDepenses: AutreDepense[];
  financements: Financement[];
  rentreesRegulieres: RentreeReguliere[];
  filtresParCategorie: FiltresParCategorie;
  periodeFiltre: PeriodeFiltre | null;
}

function ajouterFeuille(classeur: ExcelJS.Workbook, nom: string, colonnes: Partial<ExcelJS.Column>[]): ExcelJS.Worksheet {
  const feuille = classeur.addWorksheet(nom);
  feuille.columns = colonnes;
  feuille.getRow(1).font = { bold: true };
  return feuille;
}

// --- Factures clients / fournisseurs -----------------------------------------------------

function lignesFacturesClientsVisibles(params: ParametresExportExcel): FactureClient[] {
  const actives = params.facturesClients.filter((f) => !estMasqueeApresPaiement(f.payee, f.paidAt));
  const filtrePeriode = params.filtresParCategorie.facturesClients;
  const dansPeriode = filtrePeriode ? actives.filter((f) => filtrePeriode.has(f.id)) : actives;
  const filtrees = filtrerFacturesClients(dansPeriode, params.recherche);
  return params.tri === "montant"
    ? trierParMontant(filtrees, (f) => f.montant)
    : trierParDate(filtrees, (f) => f.dateEncaissementAnticipee);
}

function construireFeuilleFacturesClients(classeur: ExcelJS.Workbook, params: ParametresExportExcel) {
  const feuille = ajouterFeuille(classeur, "Factures clients", [
    { header: "Facture", key: "facture", width: 16 },
    { header: "Client", key: "client", width: 24 },
    { header: "Montant", key: "montant", width: 14, style: { numFmt: FMT_MONTANT } },
    { header: "Date d'échéance", key: "dateEcheance", width: 16, style: { numFmt: FMT_DATE } },
    { header: "Date d'encaissement prévue", key: "dateEncaissement", width: 22, style: { numFmt: FMT_DATE } },
    { header: "Litigieuse", key: "litigieuse", width: 12 },
    { header: "Payée", key: "payee", width: 10 },
    { header: "Retard", key: "retard", width: 10 },
  ]);
  for (const f of lignesFacturesClientsVisibles(params)) {
    feuille.addRow({
      facture: f.facture,
      client: f.client,
      montant: f.montant,
      dateEcheance: dateOuNull(f.dateEcheance),
      dateEncaissement: dateOuNull(f.dateEncaissementAnticipee),
      litigieuse: ouiNon(f.litigieuse),
      payee: ouiNon(f.payee),
      retard: ouiNon(estEnRetard(f.dateEncaissementAnticipee, f.payee, f.litigieuse)),
    });
  }
}

function lignesFacturesFournisseursVisibles(params: ParametresExportExcel): FactureFournisseur[] {
  const actives = params.facturesFournisseurs.filter((f) => !estMasqueeApresPaiement(f.payee, f.paidAt));
  const filtrePeriode = params.filtresParCategorie.facturesFournisseurs;
  const dansPeriode = filtrePeriode ? actives.filter((f) => filtrePeriode.has(f.id)) : actives;
  const filtrees = filtrerFacturesFournisseurs(dansPeriode, params.recherche);
  return params.tri === "montant"
    ? trierParMontant(filtrees, (f) => f.montant)
    : trierParDate(filtrees, (f) => f.datePaiementPrevue);
}

function construireFeuilleFacturesFournisseurs(classeur: ExcelJS.Workbook, params: ParametresExportExcel) {
  const feuille = ajouterFeuille(classeur, "Factures fournisseurs", [
    { header: "Facture", key: "facture", width: 16 },
    { header: "Tiers", key: "tiers", width: 24 },
    { header: "Montant", key: "montant", width: 14, style: { numFmt: FMT_MONTANT } },
    { header: "Date d'échéance", key: "dateEcheance", width: 16, style: { numFmt: FMT_DATE } },
    { header: "Date de paiement prévue", key: "datePaiement", width: 22, style: { numFmt: FMT_DATE } },
    { header: "Litigieuse", key: "litigieuse", width: 12 },
    { header: "Payée", key: "payee", width: 10 },
    { header: "Retard", key: "retard", width: 10 },
  ]);
  for (const f of lignesFacturesFournisseursVisibles(params)) {
    feuille.addRow({
      facture: f.facture,
      tiers: f.fournisseur,
      montant: f.montant,
      dateEcheance: dateOuNull(f.dateEcheance),
      datePaiement: dateOuNull(f.datePaiementPrevue),
      litigieuse: ouiNon(f.litigieuse),
      payee: ouiNon(f.payee),
      retard: ouiNon(estEnRetard(f.datePaiementPrevue, f.payee, f.litigieuse)),
    });
  }
}

// --- Charges fixes -------------------------------------------------------------------------

function lignesChargesFixesVisibles(params: ParametresExportExcel): ChargeFixe[] {
  const filtrePeriode = params.filtresParCategorie.chargesFixes;
  const dansPeriode = filtrePeriode ? params.chargesFixes.filter((c) => filtrePeriode.has(c.id)) : params.chargesFixes;
  const filtrees = filtrerChargesFixes(dansPeriode, params.recherche);
  return params.tri === "montant"
    ? trierParMontant(filtrees, (c) => montantApercuChargeFixe(c, params.chargesFixes, params.rentreesRegulieres) ?? Number.NaN)
    : trierParDate(filtrees, (c) => c.datePrevue);
}

// Reproduit exactement le calcul du montant affiché dans ChargesFixesTable (aperçu contextuel
// à la plage sélectionnée sur la courbe si elle existe, sinon aperçu par défaut).
function montantAfficheChargeFixe(charge: ChargeFixe, params: ParametresExportExcel): number | null {
  if (charge.modeMontant !== "calcule") return null;
  const occurrences = params.filtresParCategorie.chargesFixes?.get(charge.id);
  const enModeFiltre = !!params.periodeFiltre && !!occurrences && occurrences.length > 0;
  if (enModeFiltre) {
    const detail = detailChargeFixeSurPeriode(
      charge,
      occurrences!,
      params.chargesFixes,
      params.rentreesRegulieres,
      parseDateISO(params.periodeFiltre!.fin)
    );
    return detail ? detail.montantCharge : null;
  }
  return montantApercuChargeFixe(charge, params.chargesFixes, params.rentreesRegulieres);
}

function construireFeuilleChargesFixes(classeur: ExcelJS.Workbook, params: ParametresExportExcel) {
  const feuille = ajouterFeuille(classeur, "Charges fixes", [
    { header: "Libellé", key: "libelle", width: 26 },
    { header: "Montant", key: "montant", width: 14, style: { numFmt: FMT_MONTANT } },
    { header: "Date prévue", key: "datePrevue", width: 14, style: { numFmt: FMT_DATE } },
    { header: "Récurrence", key: "recurrence", width: 14 },
    { header: "Date de fin", key: "dateFin", width: 14, style: { numFmt: FMT_DATE } },
    { header: "À couper", key: "aCouper", width: 10 },
    { header: "Mode de montant", key: "modeMontant", width: 16 },
    { header: "Taux", key: "taux", width: 10, style: { numFmt: FMT_POURCENTAGE } },
    { header: "Source", key: "source", width: 24 },
    { header: "Type de source", key: "typeSource", width: 18 },
    { header: "Montant calculé affiché", key: "montantAffiche", width: 20, style: { numFmt: FMT_MONTANT } },
  ]);
  for (const c of lignesChargesFixesVisibles(params)) {
    const estCalculee = c.modeMontant === "calcule";
    feuille.addRow({
      libelle: c.libelle,
      montant: c.modeMontant === "fixe" ? c.montant : null,
      datePrevue: dateOuNull(c.datePrevue),
      recurrence: LABELS_RECURRENCE_CHARGE[c.recurrence],
      dateFin: dateOuNull(c.dateFin),
      aCouper: ouiNon(c.aCouper),
      modeMontant: estCalculee ? "Calculé" : "Fixe",
      taux: estCalculee ? c.tauxCalcul : null,
      source: estCalculee ? libelleSourceCalcul(c, params.chargesFixes, params.rentreesRegulieres) : null,
      typeSource: estCalculee
        ? c.sourceCalculType === "charge_fixe"
          ? "Charge fixe"
          : c.sourceCalculType === "rentree_reguliere"
            ? "Rentrée régulière"
            : null
        : null,
      montantAffiche: montantAfficheChargeFixe(c, params),
    });
  }
}

// --- Rentrées régulières -------------------------------------------------------------------

function lignesRentreesRegulieresVisibles(params: ParametresExportExcel): RentreeReguliere[] {
  const filtrePeriode = params.filtresParCategorie.rentreesRegulieres;
  const dansPeriode = filtrePeriode
    ? params.rentreesRegulieres.filter((r) => filtrePeriode.has(r.id))
    : params.rentreesRegulieres;
  const filtrees = filtrerRentreesRegulieres(dansPeriode, params.recherche);
  return params.tri === "montant"
    ? trierParMontant(filtrees, (r) => montantOccurrenceRentreeReguliere(r, new Date()) ?? Number.NaN)
    : trierParDate(filtrees, (r) => r.dateDebut);
}

function construireFeuilleRentreesRegulieres(classeur: ExcelJS.Workbook, params: ParametresExportExcel) {
  const feuille = ajouterFeuille(classeur, "Rentrées régulières", [
    { header: "Libellé", key: "libelle", width: 26 },
    { header: "Mode", key: "mode", width: 14 },
    { header: "Montant", key: "montant", width: 14, style: { numFmt: FMT_MONTANT } },
    { header: "Montant annuel", key: "montantAnnuel", width: 16, style: { numFmt: FMT_MONTANT } },
    { header: "Date de début", key: "dateDebut", width: 14, style: { numFmt: FMT_DATE } },
    { header: "Fréquence", key: "frequence", width: 14 },
    { header: "Date de fin", key: "dateFin", width: 14, style: { numFmt: FMT_DATE } },
    ...NOMS_MOIS.map((nom) => ({ header: `${nom} %`, key: `mois_${nom}`, width: 11, style: { numFmt: FMT_POURCENTAGE } })),
    { header: "Montant contextuel affiché", key: "montantContextuel", width: 22, style: { numFmt: FMT_MONTANT } },
  ]);
  for (const r of lignesRentreesRegulieresVisibles(params)) {
    const estSaisonnalisee = r.modeMontant === "saisonnalise";
    const profil = r.profilSaisonnalite;
    const occurrences = params.filtresParCategorie.rentreesRegulieres?.get(r.id);
    const total = profil ? totalPonderations(profil.ponderationsMensuelles) : 0;
    const etatTotal = profil ? etatTotalPonderations(total) : "invalide";
    const montantContextuel =
      params.periodeFiltre && estSaisonnalisee && profil && occurrences && occurrences.length > 0 && etatTotal !== "invalide"
        ? montantRentreeReguliereSurPeriode(r, occurrences)
        : null;

    const ligne: Record<string, unknown> = {
      libelle: r.libelle,
      mode: estSaisonnalisee ? "Saisonnalisé" : "Fixe",
      montant: !estSaisonnalisee ? r.montant : null,
      montantAnnuel: estSaisonnalisee && profil ? profil.montantAnnuel : null,
      dateDebut: dateOuNull(r.dateDebut),
      frequence: LABELS_FREQUENCE_RENTREE[r.frequence],
      dateFin: dateOuNull(r.dateFin),
      montantContextuel,
    };
    NOMS_MOIS.forEach((nom, index) => {
      ligne[`mois_${nom}`] = estSaisonnalisee && profil ? profil.ponderationsMensuelles[index] : null;
    });
    feuille.addRow(ligne);
  }
}

// --- Autres dépenses / Financements ---------------------------------------------------------

function lignesAutresDepensesVisibles(params: ParametresExportExcel): AutreDepense[] {
  const filtrePeriode = params.filtresParCategorie.autresDepenses;
  const dansPeriode = filtrePeriode ? params.autresDepenses.filter((d) => filtrePeriode.has(d.id)) : params.autresDepenses;
  const filtrees = filtrerAutresDepenses(dansPeriode, params.recherche);
  return params.tri === "montant" ? trierParMontant(filtrees, (d) => d.montant) : trierParDate(filtrees, (d) => d.datePrevue);
}

function construireFeuilleAutresDepenses(classeur: ExcelJS.Workbook, params: ParametresExportExcel) {
  const feuille = ajouterFeuille(classeur, "Autres dépenses", [
    { header: "Libellé", key: "libelle", width: 26 },
    { header: "Montant", key: "montant", width: 14, style: { numFmt: FMT_MONTANT } },
    { header: "Date", key: "date", width: 14, style: { numFmt: FMT_DATE } },
    { header: "Type", key: "type", width: 12 },
    { header: "Facturée", key: "facturee", width: 12 },
    { header: "Payée", key: "payee", width: 12 },
  ]);
  for (const d of lignesAutresDepensesVisibles(params)) {
    feuille.addRow({
      libelle: d.libelle,
      montant: d.montant,
      date: dateOuNull(d.datePrevue),
      type: LABELS_TYPE_DEPENSE[d.type],
      facturee: ouiNon(d.facturee),
      payee: ouiNon(d.payee),
    });
  }
}

function lignesFinancementsVisibles(params: ParametresExportExcel): Financement[] {
  const filtrePeriode = params.filtresParCategorie.financements;
  const dansPeriode = filtrePeriode ? params.financements.filter((f) => filtrePeriode.has(f.id)) : params.financements;
  const filtrees = filtrerFinancements(dansPeriode, params.recherche);
  return params.tri === "montant"
    ? trierParMontant(filtrees, (f) => f.montant)
    : trierParDate(filtrees, (f) => f.dateEncaissementPrevue);
}

function construireFeuilleFinancements(classeur: ExcelJS.Workbook, params: ParametresExportExcel) {
  const feuille = ajouterFeuille(classeur, "Financements", [
    { header: "Libellé", key: "libelle", width: 26 },
    { header: "Montant", key: "montant", width: 14, style: { numFmt: FMT_MONTANT } },
    { header: "Date", key: "date", width: 14, style: { numFmt: FMT_DATE } },
    { header: "Versé", key: "verse", width: 10 },
  ]);
  for (const f of lignesFinancementsVisibles(params)) {
    feuille.addRow({
      libelle: f.libelle,
      montant: f.montant,
      date: dateOuNull(f.dateEncaissementPrevue),
      verse: ouiNon(f.verse),
    });
  }
}

// --- Synthèse --------------------------------------------------------------------------------
// Reprend tel quel resultat (KPIs) et syntheseMensuelle, déjà calculés par le moteur — jamais
// recalculé pour Excel. Reste indépendant de recherche/tri/filtre de période, comme le panneau
// gauche de l'app (les filtres du panneau droit n'affectent jamais les KPIs ni la synthèse).
function construireFeuilleSynthese(classeur: ExcelJS.Workbook, params: ParametresExportExcel) {
  const feuille = classeur.addWorksheet("Synthèse");
  feuille.getColumn(1).width = 32;
  feuille.getColumn(2).width = 18;

  const ligneTitre = (texte: string) => {
    const row = feuille.addRow([texte]);
    row.font = { bold: true };
  };
  const lignePaire = (libelle: string, valeur: unknown, numFmt?: string) => {
    const row = feuille.addRow([libelle, valeur]);
    if (numFmt) row.getCell(2).numFmt = numFmt;
  };

  ligneTitre("Paramètres");
  lignePaire("Solde bancaire initial", params.soldeInitial, FMT_MONTANT);
  lignePaire("Date de départ", dateOuNull(params.dateReleve), FMT_DATE);
  lignePaire("Horizon", `${params.horizonJours} jours`);
  feuille.addRow([]);

  ligneTitre("KPIs");
  lignePaire(`Solde projeté à J+${params.horizonJours}`, params.resultat.soldeJ90, FMT_MONTANT);
  lignePaire("Point bas de trésorerie", params.resultat.pointBas, FMT_MONTANT);
  lignePaire("Date du point bas", dateOuNull(params.resultat.dateDuPointBas), FMT_DATE);
  if (params.resultat.datePassageSousZero) {
    lignePaire("Première date de passage sous zéro", dateOuNull(params.resultat.datePassageSousZero), FMT_DATE);
  } else {
    lignePaire("Première date de passage sous zéro", `Pas de passage sous zéro sur ${params.horizonJours} jours`);
  }
  feuille.addRow([]);

  ligneTitre("Synthèse mensuelle");
  const enteteMensuelle = feuille.addRow(["", ...params.syntheseMensuelle.mois.map((m) => m.libelle), "Total"]);
  enteteMensuelle.font = { bold: true };
  for (const ligne of params.syntheseMensuelle.lignes) {
    const row = feuille.addRow([ligne.libelle, ...ligne.montantsParMois, ligne.total]);
    for (let i = 2; i <= row.cellCount; i++) {
      row.getCell(i).numFmt = FMT_MONTANT;
    }
  }
}

export async function genererExportExcel(params: ParametresExportExcel): Promise<Blob> {
  const classeur = new ExcelJS.Workbook();
  classeur.creator = "Novanta";
  classeur.created = new Date();

  // L'onglet Synthèse en premier : c'est la vue d'ensemble, indépendante des filtres.
  construireFeuilleSynthese(classeur, params);
  construireFeuilleFacturesClients(classeur, params);
  construireFeuilleFacturesFournisseurs(classeur, params);
  construireFeuilleChargesFixes(classeur, params);
  construireFeuilleRentreesRegulieres(classeur, params);
  construireFeuilleAutresDepenses(classeur, params);
  construireFeuilleFinancements(classeur, params);

  const buffer = await classeur.xlsx.writeBuffer();
  return new Blob([buffer], {
    type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  });
}

export function nomFichierExportExcel(): string {
  return `novanta-export-${todayISO()}.xlsx`;
}
