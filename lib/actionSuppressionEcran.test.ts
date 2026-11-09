/**
 * Écran de suppression d'un chantier clôturé (components/ActionChantier.tsx), rendu dans jsdom :
 * emplacement de l'action, confirmation, annulation, succès, échecs.
 */
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { JSDOM } from "jsdom";

// jsdom doit être posé AVANT tout import de react-dom/client (voir analyseSessionContext.test.ts).
const dom = new JSDOM("<!doctype html><html><body></body></html>");
(globalThis as unknown as { window: unknown }).window = dom.window;
(globalThis as unknown as { document: Document }).document = dom.window.document as unknown as Document;
Object.defineProperty(globalThis, "navigator", { value: dom.window.navigator, configurable: true });
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

import React, { act, createElement } from "react";
import { createRoot, Root } from "react-dom/client";
import { FicheCloturee } from "../components/ActionChantier";
import type { ChantierCloture } from "./actionRepository";
import { IssueSuppression, MESSAGES_SUPPRESSION } from "./actionSuppression";

// Les composants sont compilés avec la transformation JSX classique : React doit être global.
(globalThis as unknown as { React: typeof React }).React = React;

const T3 = { debut: "2026-07-01", fin: "2026-09-30" };

function chantierCloture(avecPhotographie = true): ChantierCloture {
  return {
    id: "chantier-1",
    titre: "Réduire les achats",
    typePeriode: "quarter",
    periode: T3,
    clotureLe: "2026-10-02T09:00:00.000Z",
    photographie: avecPhotographie
      ? {
          version: 1,
          clotureLe: "2026-10-02T09:00:00.000Z",
          arreteAu: "2026-10-02",
          titre: "Réduire les achats",
          changement: "Renégocier les contrats fournisseurs.",
          typePeriode: "quarter",
          periode: T3,
          libellePeriode: "T3 2026",
          cartes: [],
        }
      : null,
  };
}

interface Rendu {
  conteneur: HTMLDivElement;
  root: Root;
  appels: number;
  supprimes: IssueSuppression[];
}

async function rendre(reponse: IssueSuppression | null, avecPhotographie = true): Promise<Rendu> {
  const conteneur = document.createElement("div");
  document.body.appendChild(conteneur);
  const root = createRoot(conteneur);
  const rendu: Rendu = { conteneur, root, appels: 0, supprimes: [] };
  await act(async () => {
    root.render(
      createElement(FicheCloturee, {
        chantier: chantierCloture(avecPhotographie),
        retour: () => undefined,
        ...(reponse
          ? {
              supprimer: async () => {
                rendu.appels += 1;
                return reponse;
              },
              onSupprime: (issue: IssueSuppression) => {
                rendu.supprimes.push(issue);
              },
            }
          : {}),
      })
    );
  });
  return rendu;
}

function bouton(conteneur: HTMLElement, libelle: string): HTMLButtonElement | null {
  return ([...conteneur.querySelectorAll("button")].find((b) => b.textContent?.trim() === libelle) as HTMLButtonElement | undefined) ?? null;
}

async function cliquer(b: HTMLButtonElement | null) {
  assert.ok(b, "bouton introuvable");
  await act(async () => {
    b.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true }));
  });
}

describe("Chantier clôturé : suppression définitive", () => {
  test("action discrète en pied de fiche, hors de l'en-tête", async () => {
    const { conteneur, root } = await rendre({ type: "supprime" });
    const lien = bouton(conteneur, "Supprimer ce chantier");
    assert.ok(lien);
    assert.equal(lien.className, "action-lien-secondaire");
    assert.equal(lien.closest(".action-chantier"), null, "jamais dans l'en-tête, à côté du retour");
    assert.ok(lien.closest(".action-zone-secondaire"));
    // Rien n'est demandé avant le clic.
    assert.equal(conteneur.querySelector("[role=alertdialog]"), null);
    act(() => root.unmount());
  });

  test("aussi sur la fiche d'un chantier sans photographie", async () => {
    const { conteneur, root } = await rendre({ type: "supprime" }, false);
    assert.ok(bouton(conteneur, "Supprimer ce chantier"));
    act(() => root.unmount());
  });

  test("la confirmation s'ouvre avec le titre, le message et les deux boutons", async () => {
    const { conteneur, root, appels } = await rendre({ type: "supprime" });
    await cliquer(bouton(conteneur, "Supprimer ce chantier"));
    const dialogue = conteneur.querySelector("[role=alertdialog]");
    assert.ok(dialogue);
    assert.equal(dialogue.querySelector("#action-suppression-titre")?.textContent?.trim(), "Supprimer ce chantier ?");
    assert.equal(
      dialogue.querySelector("#action-suppression-texte")?.textContent?.trim(),
      "Cette action supprimera définitivement ce chantier et son historique de suivi. Les données financières sources ne seront pas modifiées."
    );
    assert.ok(bouton(conteneur, "Annuler"));
    assert.ok(bouton(conteneur, "Supprimer définitivement"));
    assert.equal(appels, 0, "ouvrir la confirmation ne supprime rien");
    act(() => root.unmount());
  });

  test("Annuler ne change rien", async () => {
    const rendu = await rendre({ type: "supprime" });
    await cliquer(bouton(rendu.conteneur, "Supprimer ce chantier"));
    await cliquer(bouton(rendu.conteneur, "Annuler"));
    assert.equal(rendu.appels, 0);
    assert.deepEqual(rendu.supprimes, []);
    assert.equal(rendu.conteneur.querySelector("[role=alertdialog]"), null);
    assert.ok(bouton(rendu.conteneur, "Supprimer ce chantier"));
    assert.match(rendu.conteneur.textContent ?? "", /Réduire les achats/);
    act(() => rendu.root.unmount());
  });

  test("Supprimer définitivement : un seul appel, puis retour à l'historique", async () => {
    const rendu = await rendre({ type: "supprime" });
    await cliquer(bouton(rendu.conteneur, "Supprimer ce chantier"));
    await cliquer(bouton(rendu.conteneur, "Supprimer définitivement"));
    assert.equal(rendu.appels, 1);
    assert.deepEqual(rendu.supprimes, [{ type: "supprime" }]);
    act(() => rendu.root.unmount());
  });

  test("chantier déjà absent : traité comme parti, retour à l'historique", async () => {
    const rendu = await rendre({ type: "deja_absent" });
    await cliquer(bouton(rendu.conteneur, "Supprimer ce chantier"));
    await cliquer(bouton(rendu.conteneur, "Supprimer définitivement"));
    assert.deepEqual(rendu.supprimes, [{ type: "deja_absent" }]);
    act(() => rendu.root.unmount());
  });

  for (const raison of ["actif", "droits", "non_activee", "serveur"] as const) {
    test(`échec (${raison}) : le chantier reste affiché, avec le message`, async () => {
      const rendu = await rendre({ type: "echec", raison, message: MESSAGES_SUPPRESSION[raison] });
      await cliquer(bouton(rendu.conteneur, "Supprimer ce chantier"));
      await cliquer(bouton(rendu.conteneur, "Supprimer définitivement"));
      assert.deepEqual(rendu.supprimes, [], "jamais retiré localement");
      assert.equal(rendu.conteneur.querySelector(".login-erreur")?.textContent, MESSAGES_SUPPRESSION[raison]);
      assert.match(rendu.conteneur.textContent ?? "", /Réduire les achats/);
      // On peut réessayer.
      assert.equal(bouton(rendu.conteneur, "Supprimer définitivement")?.disabled, false);
      act(() => rendu.root.unmount());
    });
  }
});

describe("Chantier actif : aucune suppression proposée", () => {
  const source = readFileSync(join(process.cwd(), "components/ActionChantier.tsx"), "utf8");

  test("l'écran du chantier en cours ne monte jamais l'action de suppression", () => {
    const suivi = source.slice(source.indexOf("function SuiviCharge("), source.indexOf("function ClotureChantier("));
    assert.ok(suivi.length > 0);
    assert.doesNotMatch(suivi, /Supprim|supprim/);
    // La suppression n'est montée que par la fiche d'un chantier clôturé.
    assert.equal([...source.matchAll(/<SuppressionChantier /g)].length, 1);
    assert.match(source, /export function FicheCloturee[\s\S]*<SuppressionChantier /);
  });

  test("sans fonction de suppression, la fiche n'en propose pas", async () => {
    const { conteneur, root } = await rendre(null);
    assert.equal(bouton(conteneur, "Supprimer ce chantier"), null);
    act(() => root.unmount());
  });
});

describe("Après suppression : plus de fiche fantôme", () => {
  const source = readFileSync(join(process.cwd(), "components/ActionChantier.tsx"), "utf8");

  test("la fiche est relue dans l'historique rechargé, et l'historique vidé ramène au chantier en cours", () => {
    assert.match(source, /const vueAffichee = historique\.length > 0 \? vue : "en_cours";/);
    assert.match(source, /historique\.find\(\(c\) => c\.id === ficheId\) \?\? null/);
    assert.match(source, /setFicheId\(null\);\s+setAnnonce\(MESSAGES_SUPPRESSION\[issue\.type\]\);\s+setRechargement/);
  });
});
