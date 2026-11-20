// LECTURE SEULE : projection de Futur d'une société, à une date de départ et un horizon donnés.
import { clientAdmin } from "./connexion";
import { chargerFutur } from "./charger";
import { calculerProjectionCash, listerFluxProjetes } from "../../lib/cash-engine";

async function main() {
  const [companyId, dateDepart, horizon] = [process.argv[2], process.argv[3], Number(process.argv[4] ?? 90)];
  const { admin } = clientAdmin();
  const d = await chargerFutur(admin, companyId);
  console.log(`relevé ${d.dateReleve}, solde ${d.soldeInitial}, horizon ${d.horizonJours}`);
  const { soldeInitial, ...reste } = d;
  const params = { ...reste, dateDepart, horizonJours: horizon };
  const flux = listerFluxProjetes(params);
  for (const f of flux.sort((a, b) => a.date.localeCompare(b.date))) console.log(`${f.date} ${f.source.padEnd(20)} ${String(f.montant).padStart(10)}  ${f.libelle}`);
  const r = calculerProjectionCash({ soldeInitial, ...params });
  console.log(`flux : ${flux.length} ; point bas ${r.pointBas} le ${r.dateDuPointBas} ; fin ${r.soldeJ90}`);
  const ouvertes = d.facturesClients.filter((f) => !f.payee);
  console.log(`factures clients : ${d.facturesClients.length} (ouvertes ${ouvertes.length}) ; fournisseurs ${d.facturesFournisseurs.length} (ouvertes ${d.facturesFournisseurs.filter((f) => !f.payee).length}) ; charges ${d.chargesFixes.length} ; autres ${d.autresDepenses.length} ; financements ${d.financements.length} ; rentrées ${d.rentreesRegulieres.length} ; prévisionnelles ${d.facturesPrevisionnelles.length}`);
}
main().catch((e) => { console.error(e); process.exit(1); });
