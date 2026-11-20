// AUCUNE ÉCRITURE : exécute la chaîne réelle sur le jeu construit en mémoire (périmètre isolé).
import { executerChaine } from "./chaine";
import { jeuPilotage, OptionsJeu } from "./jeuPilotage";
import { rapport } from "./rapport";

const SOCIETE = process.argv[2] ?? "societe-demo";
const J0 = process.argv[3] ?? "2026-11-20";
for (const [titre, options] of [
  ["ÉTAT INITIAL", {}],
  ["HYPOTHÈSES RENSEIGNÉES", { hypothesesRenseignees: true }],
  ["FINANCEMENT D'ANTICIPATION", { hypothesesRenseignees: true, financementAnticipation: true }],
  ["A : DATE PASSÉE", { factureAEnRetard: "date_passee" }],
  ["A : SANS DATE", { factureAEnRetard: "sans_date" }],
] as [string, OptionsJeu][]) {
  const jeu = jeuPilotage(SOCIETE, J0, options);
  const r = executerChaine({ ...jeu, dateReleve: jeu.j0 }, jeu.hypotheses);
  console.log(`\n===== ${titre} =====\n${rapport(r, SOCIETE)}`);
}
