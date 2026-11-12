/**
 * Générateur pseudo-aléatoire reproductible de la prévision probabiliste (Mulberry32). Même graine
 * -> mêmes tirages, sur toute plateforme : indispensable aux tests et au débogage, et à l'écran
 * (une même saisie redonne exactement les mêmes chiffres, sans scintillement d'un calcul à l'autre).
 * Pas de qualité cryptographique : ce n'est pas l'objet.
 */

export interface Alea {
  /** Uniforme dans [0, 1). */
  uniforme(): number;
  /** Loi normale centrée réduite (Box-Muller). */
  normale(): number;
  /** Entier uniforme dans [0, n). */
  entier(n: number): number;
}

/** Graine par défaut : stable d'un appel à l'autre. */
export const GRAINE_PAR_DEFAUT = 20_20;

/** Graine 32 bits tirée d'une chaîne (FNV-1a) : pour dériver une graine d'un identifiant. */
export function graineDepuisTexte(texte: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < texte.length; i++) {
    h ^= texte.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

export function creerAlea(graine: number = GRAINE_PAR_DEFAUT): Alea {
  let etat = graine >>> 0;
  let normaleEnReserve: number | null = null;
  const uniforme = () => {
    etat = (etat + 0x6d2b79f5) >>> 0;
    let t = etat;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  return {
    uniforme,
    normale() {
      if (normaleEnReserve !== null) {
        const n = normaleEnReserve;
        normaleEnReserve = null;
        return n;
      }
      let u = 0;
      while (u === 0) u = uniforme();
      const v = uniforme();
      const r = Math.sqrt(-2 * Math.log(u));
      normaleEnReserve = r * Math.sin(2 * Math.PI * v);
      return r * Math.cos(2 * Math.PI * v);
    },
    entier(n: number) {
      return Math.floor(uniforme() * n);
    },
  };
}
