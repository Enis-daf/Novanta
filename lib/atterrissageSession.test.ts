import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { entrerDansLaSession, quitterLaSession } from "./atterrissageSession";

function stockage() {
  const valeurs = new Map<string, string>();
  return {
    getItem: (k: string) => valeurs.get(k) ?? null,
    setItem: (k: string, v: string) => void valeurs.set(k, v),
    removeItem: (k: string) => void valeurs.delete(k),
  };
}

describe("atterrissage de session sur Passé", () => {
  test("nouvelle session : entrée une seule fois, puis navigation libre", () => {
    const s = stockage();
    assert.equal(entrerDansLaSession(s), true);
    assert.equal(entrerDansLaSession(s), false, "retour sur Futur ou rafraîchissement dans la même session");
  });

  test("déconnexion puis reconnexion : nouvelle entrée", () => {
    const s = stockage();
    entrerDansLaSession(s);
    quitterLaSession(s);
    assert.equal(entrerDansLaSession(s), true);
  });

  test("stockage indisponible ou en erreur : jamais de redirection", () => {
    assert.equal(entrerDansLaSession(null), false);
    const casse = {
      getItem: () => {
        throw new Error("bloqué");
      },
      setItem: () => {},
      removeItem: () => {
        throw new Error("bloqué");
      },
    };
    assert.equal(entrerDansLaSession(casse), false);
    assert.doesNotThrow(() => quitterLaSession(casse));
  });
});
