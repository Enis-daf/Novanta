import { LIBELLES_OFFRES, Offre, OFFRES } from "@/lib/offres";
import { estOffrePayante, OffrePayante } from "@/lib/offresStripe";
import {
  etatCarte,
  formaterPrix,
  joursRestants,
  nouveautesDeLOffre,
  OFFRE_RECOMMANDEE,
  offrePrecedente,
  PrixAffiche,
  PROMESSES_OFFRES,
  SituationAbonnement,
} from "@/lib/offresAbonnement";

interface ChoixOffreProps {
  situation: SituationAbonnement;
  prix: Partial<Record<OffrePayante, PrixAffiche | null>>;
  // Action en cours de redirection (Checkout d'une offre, ou portail).
  enCours: OffrePayante | "portal" | null;
  onSouscrire: (offre: OffrePayante) => void;
  onPortail: () => void;
  // Ligne d'état de l'abonnement Stripe, sous les cartes ; affichée avec le bouton du portail.
  statutAbonnement: string | null;
}

// Les trois offres côte à côte (empilées sur petit écran), l'offre permanente marquée, et l'essai
// Pilotage s'il est en cours. N'attribue rien : les boutons mènent au Checkout ou au portail Stripe.
export default function ChoixOffre({ situation, prix, enCours, onSouscrire, onPortail, statutAbonnement }: ChoixOffreProps) {
  const jours = situation.essai ? joursRestants(situation.essai.fin) : null;

  return (
    <>
      {situation.essai && (
        <p className="abonnement__essai">
          <span className="etiquette etiquette--ok">Essai Pilotage en cours</span>
          {jours !== null && <span>{jours === 1 ? "1 jour restant" : `${jours} jours restants`}</span>}
        </p>
      )}

      <div className="offres-grille">
        {OFFRES.map((offre) => (
          <CarteOffre
            key={offre}
            offre={offre}
            situation={situation}
            prix={estOffrePayante(offre) ? prix[offre] ?? null : null}
            enCours={enCours}
            onSouscrire={onSouscrire}
            onPortail={onPortail}
          />
        ))}
      </div>

      {situation.portailDisponible && (
        <section className="abonnement__gestion">
          {statutAbonnement && <p className="abonnement__statut">{statutAbonnement}</p>}
          <button type="button" className="btn-secondaire" onClick={onPortail} disabled={enCours !== null}>
            {enCours === "portal" ? "Redirection…" : "Gérer mon abonnement"}
          </button>
        </section>
      )}
    </>
  );
}

interface CarteOffreProps {
  offre: Offre;
  situation: SituationAbonnement;
  prix: PrixAffiche | null;
  enCours: OffrePayante | "portal" | null;
  onSouscrire: (offre: OffrePayante) => void;
  onPortail: () => void;
}

function CarteOffre({ offre, situation, prix, enCours, onSouscrire, onPortail }: CarteOffreProps) {
  const { action, incluseDansEssai } = etatCarte(offre, situation);
  const precedente = offrePrecedente(offre);
  const libelle = LIBELLES_OFFRES[offre];
  const montant = prix ? formaterPrix(prix) : null;
  const classes = [
    "offre-carte",
    action === "actuelle" && "offre-carte--actuelle",
    offre === OFFRE_RECOMMANDEE && "offre-carte--recommandee",
  ].filter(Boolean);

  return (
    <article className={classes.join(" ")} aria-current={action === "actuelle" ? "true" : undefined}>
      <div className="offre-carte__entete">
        <h2 className="offre-carte__nom">{libelle}</h2>
        {offre === OFFRE_RECOMMANDEE && <span className="etiquette offre-carte__badge">Recommandé</span>}
      </div>
      <p className="offre-carte__promesse">{PROMESSES_OFFRES[offre]}</p>

      <p className="offre-carte__prix">
        {offre === "essential" ? (
          <span className="offre-carte__montant">Gratuit</span>
        ) : montant ? (
          <>
            <span className="offre-carte__montant">{montant.montant}</span>
            <span className="offre-carte__periode">{montant.periode}</span>
          </>
        ) : (
          <span className="offre-carte__periode">Prix indisponible</span>
        )}
      </p>

      <div className="offre-carte__action">
        {action === "actuelle" && (
          <button type="button" className="btn-secondaire" disabled>
            Votre offre actuelle
          </button>
        )}
        {action === "checkout" && estOffrePayante(offre) && (
          <button type="button" className="btn-add" onClick={() => onSouscrire(offre)} disabled={enCours !== null}>
            {enCours === offre ? "Redirection…" : `Choisir ${libelle}`}
          </button>
        )}
        {action === "portail" && (
          <button type="button" className="btn-secondaire" onClick={onPortail} disabled={enCours !== null}>
            {enCours === "portal" ? "Redirection…" : `Choisir ${libelle}`}
          </button>
        )}
        {incluseDansEssai && <p className="offre-carte__essai">Inclus actuellement dans votre essai</p>}
      </div>

      <p className="offre-carte__socle">{precedente ? `Tout ${LIBELLES_OFFRES[precedente]}, plus :` : "Inclus :"}</p>
      <ul className="offre-carte__liste">
        {nouveautesDeLOffre(offre).map((ligne) => (
          <li key={ligne}>{ligne}</li>
        ))}
      </ul>
    </article>
  );
}
