"use client";

import { useRef, useState } from "react";
import { formatDateCourte } from "@/lib/dates";
import { formatMontantComptable } from "@/lib/format";
import type { ResultatImportFec } from "@/lib/comptaRepository";
import type { ImportFec } from "@/lib/comptaSources";
import { AnalyseFec, AnomalieFec, analyserFec, ImportFecPrepare, preparerImportFec, TAILLE_MAX_FICHIER_FEC } from "@/lib/fecParseur";
import { Periode } from "@/lib/pastTransactions";

interface PasseImportFecProps {
  imports: ImportFec[];
  importer: (preparation: ImportFecPrepare, remplacer: boolean) => Promise<ResultatImportFec>;
  onImporte: () => void;
  onRetirer: (id: string) => void;
  onVoir: (periode: Periode) => void;
  onCorrespondance: (periode: Periode) => void;
}

type EtatEnvoi = { etat: "pret" } | { etat: "envoi" } | { etat: "importe" } | { etat: "identique" } | { etat: "chevauchement"; avec: { debut: string; fin: string; fichier: string }[] } | { etat: "erreur"; message: string };

interface FichierEnCours {
  cle: string;
  nom: string;
  analyse: AnalyseFec | null;
  erreur: string | null;
  debut: string;
  fin: string;
  cloture: boolean;
  envoi: EtatEnvoi;
}

const formatNombre = new Intl.NumberFormat("fr-FR");

/** Le fichier est lu par morceaux, dans le navigateur : il ne part jamais au serveur. */
async function* morceauxDuFichier(fichier: File): AsyncGenerator<Uint8Array> {
  const lecteur = fichier.stream().getReader();
  try {
    for (;;) {
      const { done, value } = await lecteur.read();
      if (done) return;
      yield value;
    }
  } finally {
    lecteur.releaseLock();
  }
}

function ListeAnomalies({ anomalies, gravite, titre }: { anomalies: AnomalieFec[]; gravite: AnomalieFec["gravite"]; titre: string }) {
  const liste = anomalies.filter((a) => a.gravite === gravite);
  if (liste.length === 0) return null;
  return (
    <div className={`fec-anomalies fec-anomalies--${gravite}`}>
      <p className="fec-anomalies__titre">{titre}</p>
      <ul>
        {liste.map((a) => (
          <li key={a.code}>
            {a.message}
            {a.nombre !== undefined && ` (${formatNombre.format(a.nombre)})`}
            {a.lignes && a.lignes.length > 0 && ` Lignes : ${a.lignes.join(", ")}${(a.nombre ?? 0) > a.lignes.length ? "…" : ""}.`}
          </li>
        ))}
      </ul>
    </div>
  );
}

// Importer un ou plusieurs FEC, vérifier les exercices et les contrôles, puis ouvrir le P&L historique. Le fichier
// n'est ni modifié ni conservé : seules ses balances mensuelles sont enregistrées.
export default function PasseImportFec({ imports, importer, onImporte, onRetirer, onVoir, onCorrespondance }: PasseImportFecProps) {
  const [fichiers, setFichiers] = useState<FichierEnCours[]>([]);
  const champ = useRef<HTMLInputElement>(null);
  const modifier = (cle: string, patch: Partial<FichierEnCours>) => setFichiers((liste) => liste.map((f) => (f.cle === cle ? { ...f, ...patch } : f)));

  const choisir = async (liste: FileList | null) => {
    if (!liste) return;
    for (const fichier of [...liste]) {
      const cle = `${fichier.name}-${fichier.size}-${fichier.lastModified}`;
      const base: FichierEnCours = { cle, nom: fichier.name, analyse: null, erreur: null, debut: "", fin: "", cloture: false, envoi: { etat: "pret" } };
      setFichiers((actuels) => [...actuels.filter((f) => f.cle !== cle), base]);
      if (fichier.size > TAILLE_MAX_FICHIER_FEC) {
        modifier(cle, { erreur: "Ce fichier dépasse la taille maximale de 500 Mo." });
        continue;
      }
      try {
        const analyse = await analyserFec(() => morceauxDuFichier(fichier), fichier.name);
        modifier(cle, { analyse, debut: analyse.exercice?.debut ?? "", fin: analyse.exercice?.fin ?? "" });
      } catch {
        modifier(cle, { erreur: "Ce fichier n'a pas pu être lu." });
      }
    }
    if (champ.current) champ.current.value = "";
  };

  const envoyer = async (f: FichierEnCours, remplacer: boolean) => {
    if (!f.analyse) return;
    modifier(f.cle, { envoi: { etat: "envoi" } });
    try {
      const resultat = await importer(preparerImportFec(f.analyse, { debut: f.debut, fin: f.fin, cloture: f.cloture }), remplacer);
      if (resultat.statut === "chevauchement") {
        modifier(f.cle, { envoi: { etat: "chevauchement", avec: resultat.chevauchements } });
        return;
      }
      modifier(f.cle, { envoi: { etat: resultat.statut } });
      onImporte();
    } catch (e) {
      modifier(f.cle, { envoi: { etat: "erreur", message: (e as Error).message } });
    }
  };

  const actifs = imports.filter((i) => i.statut === "active").sort((a, b) => b.debut.localeCompare(a.debut));
  const anciens = imports.filter((i) => i.statut !== "active");

  return (
    <div className="fec">
      <div className="fec-depot">
        <label className="passe-controle__label" htmlFor="fec-fichiers">
          Fichiers des écritures comptables
        </label>
        <input id="fec-fichiers" ref={champ} type="file" multiple accept=".txt,.csv,.fec,.tsv,text/plain" onChange={(e) => choisir(e.target.files)} />
        <p className="passe-message">Le fichier est lu sur votre poste. Seules les balances mensuelles par compte sont enregistrées : ni le fichier, ni ses écritures, ni leurs libellés.</p>
      </div>

      {fichiers.map((f) => {
        const a = f.analyse;
        const lectureSeule = f.envoi.etat === "importe" || f.envoi.etat === "identique";
        const periode = { debut: f.debut, fin: f.fin };
        return (
          <section key={f.cle} className="fec-fichier" aria-label={`Fichier ${f.nom}`}>
            <h3 className="fec-fichier__nom">{f.nom}</h3>
            {f.erreur && <p className="login-erreur">{f.erreur}</p>}
            {!a && !f.erreur && <p className="passe-message">Lecture du fichier…</p>}
            {a && (
              <>
                <dl className="fec-resume">
                  <div>
                    <dt>Écritures</dt>
                    <dd>{formatNombre.format(a.nombreEcritures)}</dd>
                  </div>
                  <div>
                    <dt>Lignes</dt>
                    <dd>{formatNombre.format(a.nombreLignes)}</dd>
                  </div>
                  <div>
                    <dt>Comptes</dt>
                    <dd>{formatNombre.format(a.nombreComptes)}</dd>
                  </div>
                  <div>
                    <dt>Résultat reconstitué</dt>
                    <dd>{a.bloquant ? "—" : formatMontantComptable(a.controles.resultatReconstitue)}</dd>
                  </div>
                  <div>
                    <dt>Format</dt>
                    <dd>
                      {a.encodage}, {a.separateur}
                    </dd>
                  </div>
                </dl>

                <ListeAnomalies anomalies={a.anomalies} gravite="bloquante" titre="À corriger dans le fichier : import impossible" />
                <ListeAnomalies anomalies={a.anomalies} gravite="non_bloquante" titre="À vérifier : l'import reste possible" />
                <ListeAnomalies anomalies={a.anomalies} gravite="information" titre="Pour information" />

                {!a.bloquant && (
                  <div className="fec-exercice">
                    <div className="compta-saisie__champ">
                      <label className="passe-controle__label" htmlFor={`${f.cle}-debut`}>
                        Début de l&apos;exercice
                      </label>
                      <input id={`${f.cle}-debut`} type="date" value={f.debut} disabled={lectureSeule} onChange={(e) => modifier(f.cle, { debut: e.target.value })} />
                    </div>
                    <div className="compta-saisie__champ">
                      <label className="passe-controle__label" htmlFor={`${f.cle}-fin`}>
                        Fin de l&apos;exercice
                      </label>
                      <input id={`${f.cle}-fin`} type="date" value={f.fin} disabled={lectureSeule} onChange={(e) => modifier(f.cle, { fin: e.target.value })} />
                    </div>
                    <label className="fec-exercice__cloture">
                      <input type="checkbox" checked={f.cloture} disabled={lectureSeule} onChange={(e) => modifier(f.cle, { cloture: e.target.checked })} />
                      Exercice clôturé
                    </label>
                    {!lectureSeule && f.envoi.etat !== "chevauchement" && (
                      <button type="button" className="btn-add" disabled={f.envoi.etat === "envoi" || !f.debut || !f.fin} onClick={() => envoyer(f, false)}>
                        {f.envoi.etat === "envoi" ? "Enregistrement…" : "Importer"}
                      </button>
                    )}
                  </div>
                )}

                {f.envoi.etat === "erreur" && <p className="login-erreur">{f.envoi.message}</p>}
                {f.envoi.etat === "identique" && <p className="passe-message">Ce contenu est déjà importé : rien n&apos;a été ajouté ni additionné.</p>}
                {f.envoi.etat === "chevauchement" && (
                  <div className="passe-message passe-flux-hors-pnl" role="alert">
                    <p>
                      Cette période recoupe {f.envoi.avec.length > 1 ? `${f.envoi.avec.length} imports existants` : "un import existant"} :{" "}
                      {f.envoi.avec.map((x) => `${x.fichier} (du ${formatDateCourte(x.debut)} au ${formatDateCourte(x.fin)})`).join(", ")}. Deux imports ne s&apos;additionnent jamais : le remplacement écarte l&apos;ancien, qui reste dans l&apos;historique. Les correspondances et les ajustements sont conservés.
                    </p>
                    <div className="passe-tri selecteur" role="group" aria-label="Remplacement de l'import">
                      <button type="button" className="btn-secondaire" onClick={() => envoyer(f, true)}>
                        Remplacer l&apos;import existant
                      </button>
                      <button type="button" className="btn-secondaire" onClick={() => modifier(f.cle, { envoi: { etat: "pret" } })}>
                        Annuler
                      </button>
                    </div>
                  </div>
                )}
                {(f.envoi.etat === "importe" || f.envoi.etat === "identique") && (
                  <div className="passe-tri selecteur" role="group" aria-label="Suite de l'import">
                    <button type="button" className="btn-secondaire" onClick={() => onVoir(periode)}>
                      Voir le P&amp;L de cet exercice
                    </button>
                    <button type="button" className="btn-secondaire" onClick={() => onCorrespondance(periode)}>
                      Compléter la correspondance
                    </button>
                  </div>
                )}
              </>
            )}
          </section>
        );
      })}

      {actifs.length > 0 && (
        <section className="fec-liste" aria-label="Imports enregistrés">
          <p className="passe-controle__label">Imports enregistrés</p>
          <div className="table-wrapper">
            <table className="passe-table">
              <thead>
                <tr>
                  <th>Fichier</th>
                  <th>Exercice</th>
                  <th>Statut</th>
                  <th className="col-montant">Résultat à l&apos;import</th>
                  <th>
                    <span className="passe-visuellement-cache">Actions</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {actifs.map((i) => (
                  <tr key={i.id}>
                    <td className="passe-table__libelle">{i.nomFichier}</td>
                    <td>
                      {formatDateCourte(i.debut)} → {formatDateCourte(i.fin)}
                    </td>
                    <td>{i.cloture ? "Clôturé" : "Non clôturé"}</td>
                    <td className="col-montant passe-table__montant">{i.resume.resultat === undefined ? "—" : formatMontantComptable(i.resume.resultat)}</td>
                    <td className="passe-signes-detail__action">
                      <button type="button" className="passe-lien-ligne" onClick={() => onVoir({ debut: i.debut, fin: i.fin })}>
                        Voir
                      </button>{" "}
                      <button type="button" className="passe-lien-ligne" onClick={() => onRetirer(i.id)}>
                        Retirer
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}
      {anciens.length > 0 && (
        <details className="compta-regles">
          <summary>Historique des imports ({anciens.length})</summary>
          <ul className="fec-historique">
            {anciens.map((i) => (
              <li key={i.id}>
                {i.nomFichier}, du {formatDateCourte(i.debut)} au {formatDateCourte(i.fin)} : {i.statut === "replaced" ? "remplacé" : "retiré"}
              </li>
            ))}
          </ul>
        </details>
      )}
    </div>
  );
}
