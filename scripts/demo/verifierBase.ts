// LECTURE SEULE : relit le compte démo en base et exécute la chaîne réelle de Perspectives pondérées.
import { clientAdmin } from "./connexion";
import { chargerFutur } from "./charger";
import { executerChaine } from "./chaine";
import { rapport } from "./rapport";
import { SOCIETE } from "./seedPilotage";
import { chargerHypotheses } from "../../lib/probaRepository";
import { chargerFacturesBfr } from "../../lib/pastBfrRepository";

async function main() {
  const { admin } = clientAdmin();
  const d = await chargerFutur(admin, SOCIETE);
  const hypotheses = await chargerHypotheses(admin, SOCIETE);
  const { factures } = await chargerFacturesBfr(admin, SOCIETE);
  const r = executerChaine({ ...d, horizonJours: d.horizonJours }, hypotheses, factures);
  console.log(`Base : relevé ${d.dateReleve}, solde ${d.soldeInitial}, horizon ${d.horizonJours} ; ${hypotheses.length} hypothèses ; historique Pennylane ${factures.length} factures`);
  console.log(`Flux J0-J30 :`);
  for (const f of r.flux.filter((x) => x.date <= r.dates[30])) console.log(`  ${f.date} ${f.source} ${f.montant} ${f.libelle}`);
  console.log(`Flux après J30 : ${r.flux.filter((x) => x.date > r.dates[30]).map((x) => `${x.date} ${x.montant}`).join(" · ")}`);
  console.log(rapport(r, SOCIETE));
}
main().catch((e) => { console.error(e); process.exit(1); });
