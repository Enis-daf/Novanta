/**
 * Serveur mock de l'API Pennylane v2 — LOCAL uniquement, données synthétiques (voir fixtures.ts).
 * Rejoue de façon déterministe les scénarios de synchronisation ; l'application le contacte via
 * PENNYLANE_API_BASE_URL, acceptée uniquement en mode staging (voir lib/pennylaneClient.ts).
 *
 *   npm run staging:mock                  -> démarre au cycle 1 sur http://localhost:4010
 *   npm run staging:mock -- --cycle 2     -> démarre directement au cycle 2
 *   curl -X POST http://localhost:4010/__mock/cycle/2   -> change de cycle sans redémarrer
 *   curl http://localhost:4010/__mock/etat               -> cycle courant et volumes
 *
 * Reproduit le contrat utilisé par lib/pennylaneClient.ts : Bearer obligatoire, pagination par
 * curseur { items, has_more, next_cursor }, limit 1..100. Le token reçu n'est jamais journalisé.
 */
import { createServer, IncomingMessage, ServerResponse } from "node:http";
import { facturesClientsMock, facturesFournisseursMock } from "./fixtures";

const PORT = Number(process.env.PENNYLANE_MOCK_PORT ?? 4010);
const PREFIXE = "/api/external/v2";

const indexCycle = process.argv.indexOf("--cycle");
let cycle = indexCycle >= 0 ? Number(process.argv[indexCycle + 1]) || 1 : 1;

function repondre(res: ServerResponse, statut: number, corps: unknown): void {
  res.writeHead(statut, { "content-type": "application/json" });
  res.end(JSON.stringify(corps));
}

function paginer<T>(items: T[], url: URL): { items: T[]; has_more: boolean; next_cursor: string | null } {
  const limite = Math.min(Math.max(Number(url.searchParams.get("limit")) || 20, 1), 100);
  const debut = Number(Buffer.from(url.searchParams.get("cursor") ?? "", "base64url").toString() || 0);
  const page = items.slice(debut, debut + limite);
  const suivant = debut + limite;
  const resteDesPages = suivant < items.length;
  return {
    items: page,
    has_more: resteDesPages,
    next_cursor: resteDesPages ? Buffer.from(String(suivant)).toString("base64url") : null,
  };
}

function traiter(req: IncomingMessage, res: ServerResponse): void {
  const url = new URL(req.url ?? "/", `http://localhost:${PORT}`);
  const chemin = url.pathname;

  if (chemin === "/__mock/etat") {
    const aujourdhui = new Date();
    return repondre(res, 200, {
      cycle,
      facturesFournisseurs: facturesFournisseursMock(cycle, aujourdhui).length,
      facturesClients: facturesClientsMock(cycle, aujourdhui).length,
    });
  }
  const changement = chemin.match(/^\/__mock\/cycle\/(\d+)$/);
  if (changement && req.method === "POST") {
    cycle = Number(changement[1]);
    console.log(`[mock pennylane] cycle -> ${cycle}`);
    return repondre(res, 200, { cycle });
  }

  const bearer = req.headers.authorization ?? "";
  if (!bearer.startsWith("Bearer ") || bearer.length <= "Bearer ".length) {
    return repondre(res, 401, { error: "unauthorized" });
  }

  const aujourdhui = new Date();
  if (chemin === `${PREFIXE}/me`) return repondre(res, 200, { company: { name: "QANNT TEST (mock)" } });
  if (chemin === `${PREFIXE}/supplier_invoices`) {
    const page = paginer(facturesFournisseursMock(cycle, aujourdhui), url);
    console.log(`[mock pennylane] supplier_invoices cycle=${cycle} page=${page.items.length} has_more=${page.has_more}`);
    return repondre(res, 200, page);
  }
  if (chemin === `${PREFIXE}/customer_invoices`) {
    return repondre(res, 200, paginer(facturesClientsMock(cycle, aujourdhui), url));
  }
  if (chemin === `${PREFIXE}/transactions` || chemin === `${PREFIXE}/category_groups`) {
    return repondre(res, 200, { items: [], has_more: false, next_cursor: null });
  }
  return repondre(res, 404, { error: "not_found" });
}

// Écoute sur la boucle locale uniquement : jamais joignable depuis le réseau.
createServer(traiter).listen(PORT, "127.0.0.1", () => {
  console.log(`[mock pennylane] http://localhost:${PORT} — cycle ${cycle} — données synthétiques`);
});
