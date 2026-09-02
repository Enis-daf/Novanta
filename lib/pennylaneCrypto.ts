import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

/**
 * Chiffrement du Company API Token Pennylane — SERVEUR UNIQUEMENT. Ne jamais importer ce module
 * depuis un composant "use client" ni depuis un fichier exécuté dans le navigateur : la clé de
 * chiffrement (PENNYLANE_TOKEN_ENCRYPTION_KEY) ne doit exister que côté serveur.
 *
 * AES-256-GCM (authentifié : toute altération du texte chiffré est détectée au déchiffrement,
 * jamais silencieusement acceptée). Aucune dépendance ajoutée — module "crypto" natif de Node.
 *
 * Format stocké (une seule colonne texte) : "v1:<iv base64>:<authTag base64>:<ciphertext base64>"
 * — préfixé par une version pour permettre une future rotation d'algorithme sans migration de
 * données bloquante.
 */

const ALGORITHME = "aes-256-gcm";
const LONGUEUR_IV = 12; // recommandé pour GCM
const VERSION = "v1";

function cle(): Buffer {
  const brute = process.env.PENNYLANE_TOKEN_ENCRYPTION_KEY;
  if (!brute) {
    throw new Error(
      "PENNYLANE_TOKEN_ENCRYPTION_KEY n'est pas configurée : impossible de chiffrer/déchiffrer un token Pennylane."
    );
  }
  const tampon = Buffer.from(brute, "base64");
  if (tampon.length !== 32) {
    throw new Error(
      "PENNYLANE_TOKEN_ENCRYPTION_KEY doit être une clé de 32 octets encodée en base64 (ex: `openssl rand -base64 32`)."
    );
  }
  return tampon;
}

/**
 * Vérification NON destructive (ne lève jamais) de la présence et du format de la clé de
 * chiffrement — à appeler avant tout appel Pennylane, pour échouer proprement (config serveur
 * manquante) plutôt que de laisser un chiffrement échouer après un appel API déjà effectué.
 */
export function cleChiffrementConfiguree(): boolean {
  const brute = process.env.PENNYLANE_TOKEN_ENCRYPTION_KEY;
  if (!brute) return false;
  try {
    return Buffer.from(brute, "base64").length === 32;
  } catch {
    return false;
  }
}

export function chiffrerTokenPennylane(clair: string): string {
  const iv = randomBytes(LONGUEUR_IV);
  const cipher = createCipheriv(ALGORITHME, cle(), iv);
  const chiffre = Buffer.concat([cipher.update(clair, "utf8"), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return `${VERSION}:${iv.toString("base64")}:${authTag.toString("base64")}:${chiffre.toString("base64")}`;
}

export function dechiffrerTokenPennylane(stocke: string): string {
  const parties = stocke.split(":");
  if (parties.length !== 4 || parties[0] !== VERSION) {
    throw new Error("Format de token Pennylane chiffré invalide ou version non reconnue.");
  }
  const [, ivB64, authTagB64, chiffreB64] = parties;
  const decipher = createDecipheriv(ALGORITHME, cle(), Buffer.from(ivB64, "base64"));
  decipher.setAuthTag(Buffer.from(authTagB64, "base64"));
  const clair = Buffer.concat([decipher.update(Buffer.from(chiffreB64, "base64")), decipher.final()]);
  return clair.toString("utf8");
}
