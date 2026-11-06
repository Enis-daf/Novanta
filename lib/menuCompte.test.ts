import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const lire = (chemin: string) => readFileSync(join(process.cwd(), chemin), "utf8");

// Garde-fous : un seul menu de compte, branché sur la déconnexion existante de chaque page.
describe("menu de compte", () => {
  const menu = lire("components/MenuCompte.tsx");

  test("ouverture, fermeture au clic extérieur et sur Échap, accessibilité", () => {
    assert.ok(menu.includes('aria-haspopup="menu"'));
    assert.ok(menu.includes("aria-expanded={ouvert}"));
    assert.ok(menu.includes('role="menu"'));
    assert.equal(menu.match(/role="menuitem" className/g)?.length, 2);
    assert.ok(menu.includes('document.addEventListener("mousedown", gererClicExterieur)'));
    assert.ok(menu.includes('e.key === "Escape"'));
  });

  test("ne contient que « Changer de compte » et « Se déconnecter »", () => {
    assert.ok(menu.includes("Changer de compte"));
    assert.ok(menu.includes("Se déconnecter"));
  });

  test("aucune logique d'authentification propre : la déconnexion vient de la page", () => {
    assert.ok(!menu.includes("supabaseClient") && !/\.auth\.\w+\(/.test(menu));
    assert.equal(menu.match(/await onDeconnexion\(\)/g)?.length, 2);
  });

  test("pages Compte : l'en-tête passe au-dessus du contenu, le menu reste cliquable", () => {
    const css = lire("app/globals.css");
    const entete = css.match(/\.billing-page__header \{\s*position: relative;\s*z-index: (\d+);/);
    const contenu = css.match(/\.abonnement \{\s*position: relative;\s*z-index: (\d+);/);
    assert.ok(entete && contenu);
    assert.ok(Number(entete[1]) > Number(contenu[1]));
  });

  test("tous les en-têtes qui affichent l'e-mail passent par MenuCompte", () => {
    for (const chemin of ["components/EnTeteCockpit.tsx", "app/account/billing/page.tsx", "app/account/integrations/page.tsx"]) {
      const source = lire(chemin);
      assert.ok(source.includes("<MenuCompte"), chemin);
      assert.ok(!/<span[^>]*>\{(session\.user|compte)\.email\}<\/span>/.test(source), chemin);
    }
  });
});
