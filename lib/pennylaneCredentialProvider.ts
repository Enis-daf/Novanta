/**
 * Abstraction d'authentification Pennylane — SERVEUR UNIQUEMENT.
 *
 * PennylaneClient (et tout ce qui l'utilise : l'adapter, les routes) ne dépend QUE de cette
 * interface, jamais du type d'authentification concret. Au passage MVP (Company API Token) → V1
 * (OAuth), seul le provider change : PennylaneClient, PennylaneTransactionAdapter,
 * detecterChargesRecurrentes, controlerCoherence et les écrans ne sont jamais modifiés.
 *
 * Conceptuellement : CredentialProvider -> Bearer credential (string) -> PennylaneClient.
 * Le Company API Token n'est donc jamais passé directement aux fonctions métier — uniquement à un
 * provider, qui l'expose sous forme d'un header Bearer déjà prêt.
 */
export interface PennylaneCredentialProvider {
  /** Le token à utiliser tel quel dans le header `Authorization: Bearer <...>`. */
  getBearerToken(): Promise<string>;
}

/**
 * MVP : le credential est directement le Company API Token de l'entreprise, déjà déchiffré par
 * l'appelant (voir lib/pennylaneRepository.ts). Ce provider ne fait aucun appel réseau : le token
 * est fourni tel quel par la couche d'accès aux données.
 */
export class CompanyApiTokenCredentialProvider implements PennylaneCredentialProvider {
  constructor(private readonly token: string) {}

  async getBearerToken(): Promise<string> {
    return this.token;
  }
}

// V1 (non implémenté dans ce MVP) : un OAuthCredentialProvider gérerait le rafraîchissement du
// token d'accès (refresh token, expiration) derrière la même interface getBearerToken(), sans
// qu'aucune autre couche n'ait besoin d'être modifiée.
// export class OAuthCredentialProvider implements PennylaneCredentialProvider { ... }
