import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  ROUTE_REINITIALISATION,
  lireLienAuth,
  messageErreurMiseAJour,
  messageLienInvalide,
  redirectionVersReinitialisation,
  verifierNouveauMotDePasse,
} from "./recuperationMotDePasse";

const SITE = "https://novanta.example";
const fragmentRecuperation = "#access_token=jeton-a&expires_at=1&expires_in=3600&refresh_token=r&token_type=bearer&type=recovery";

describe("lecture du lien d'e-mail", () => {
  test("flux implicite : session de récupération dans le fragment", () => {
    assert.deepEqual(lireLienAuth(`${SITE}/${fragmentRecuperation}`), { type: "recuperation-implicite", accessToken: "jeton-a" });
  });
  test("modèle personnalisé token_hash", () => {
    assert.deepEqual(lireLienAuth(`${SITE}${ROUTE_REINITIALISATION}?token_hash=h1&type=recovery`), {
      type: "recuperation-token-hash",
      tokenHash: "h1",
    });
  });
  test("lien expiré ou déjà utilisé", () => {
    assert.deepEqual(
      lireLienAuth(`${SITE}/#error=access_denied&error_code=otp_expired&error_description=Email+link+is+invalid+or+has+expired`),
      { type: "erreur", code: "otp_expired" },
    );
  });
  test("connexion par lien magique ou confirmation d'inscription : pas une récupération", () => {
    assert.deepEqual(lireLienAuth(`${SITE}/#access_token=x&refresh_token=r&type=signup`), { type: "aucun" });
    assert.deepEqual(lireLienAuth(`${SITE}/#access_token=x&refresh_token=r&type=magiclink`), { type: "aucun" });
  });
  test("URL ordinaire, absente ou illisible", () => {
    assert.deepEqual(lireLienAuth(`${SITE}/passe`), { type: "aucun" });
    assert.deepEqual(lireLienAuth(null), { type: "aucun" });
    assert.deepEqual(lireLienAuth("pas une url"), { type: "aucun" });
  });
});

describe("redirection vers l'écran dédié", () => {
  test("récupération lancée depuis le dashboard : arrivée sur la Site URL, renvoyée avec ses paramètres", () => {
    assert.equal(redirectionVersReinitialisation(`${SITE}/${fragmentRecuperation}`), `${ROUTE_REINITIALISATION}${fragmentRecuperation}`);
    assert.equal(
      redirectionVersReinitialisation(`${SITE}/?token_hash=h1&type=recovery`),
      `${ROUTE_REINITIALISATION}?token_hash=h1&type=recovery`,
    );
  });
  test("déjà sur l'écran dédié : pas de boucle", () => {
    assert.equal(redirectionVersReinitialisation(`${SITE}${ROUTE_REINITIALISATION}${fragmentRecuperation}`), null);
  });
  test("erreur, autre type de lien ou URL ordinaire : rien", () => {
    assert.equal(redirectionVersReinitialisation(`${SITE}/#error=access_denied&error_code=otp_expired`), null);
    assert.equal(redirectionVersReinitialisation(`${SITE}/#access_token=x&refresh_token=r&type=signup`), null);
    assert.equal(redirectionVersReinitialisation(`${SITE}/action`), null);
  });
});

describe("saisie et refus", () => {
  test("mots de passe différents ou trop courts", () => {
    assert.match(verifierNouveauMotDePasse("abcdef", "abcdeg")!, /pas identiques/);
    assert.match(verifierNouveauMotDePasse("abc", "abc")!, /au moins 6/);
    assert.equal(verifierNouveauMotDePasse("abcdef", "abcdef"), null);
  });
  test("messages de lien et de mise à jour", () => {
    assert.match(messageLienInvalide("otp_expired"), /expiré ou a déjà été utilisé/);
    assert.match(messageLienInvalide(null), /n'est pas valide/);
    assert.match(messageErreurMiseAJour({ code: "same_password" }), /différent de l'ancien/);
    assert.match(messageErreurMiseAJour({ status: 401 }), /lien a expiré/);
    assert.match(messageErreurMiseAJour({ code: "weak_password", message: "Password should contain digits." }), /trop faible\. Password/);
    assert.match(messageErreurMiseAJour({}), /Veuillez réessayer/);
  });
});
