import Link from "next/link";
import NavigationModules from "@/components/NavigationModules";

interface EnTeteCockpitProps {
  moduleActif: "passe" | "futur";
  // Absent tant que la session n'est pas là (Futur en mode local) : seul le titre est affiché.
  compte?: {
    email: string | undefined;
    passeDisponible: boolean;
    onDeconnexion: () => void;
  };
}

// En-tête commun aux deux modules (Futur et Passé) : même titre, même navigation, mêmes actions de
// compte. Chaque page garde sa propre logique (session, déconnexion) et la lui passe.
export default function EnTeteCockpit({ moduleActif, compte }: EnTeteCockpitProps) {
  return (
    <header className="page-intro">
      <div className="page-intro__texte">
        <h1 className="page-intro__titre-compact">
          <span className="page-intro__marque">Novanta</span>
          <span className="ornement" aria-hidden="true" />
          <span className="page-intro__produit">cockpit de trésorerie</span>
        </h1>
      </div>
      {compte && (
        <div className="page-intro__actions">
          <span className="page-intro__email">{compte.email}</span>
          <NavigationModules moduleActif={moduleActif} passeDisponible={compte.passeDisponible} />
          <Link href="/account/billing" className="btn-secondaire">
            Abonnement
          </Link>
          <Link href="/account/integrations" className="btn-secondaire">
            Intégrations
          </Link>
          <button type="button" className="btn-deconnexion" onClick={compte.onDeconnexion}>
            Se déconnecter
          </button>
        </div>
      )}
    </header>
  );
}
