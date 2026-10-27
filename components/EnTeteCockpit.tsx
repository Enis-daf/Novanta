import Link from "next/link";
import NavigationModules, { ModuleCockpit } from "@/components/NavigationModules";

interface EnTeteCockpitProps {
  moduleActif: ModuleCockpit;
  // Absent tant que la session n'est pas là (Futur en mode local) : seul le titre est affiché.
  compte?: {
    email: string | undefined;
    passeDisponible: boolean;
    onDeconnexion: () => void;
  };
}

// Titre de chaque module, sous la ligne de l'en-tête : même emplacement et même style pour tous.
const TITRES_ECRAN: Record<ModuleCockpit, string> = {
  passe: "Analyse des flux de trésorerie",
  action: "Chantier de rentabilité",
  futur: "Projection de trésorerie",
};

// En-tête commun aux modules (Passé, Action, Futur) : même titre, même navigation, mêmes actions de
// compte, puis le titre de l'écran. Chaque page garde sa propre logique (session, déconnexion) et
// la lui passe.
export default function EnTeteCockpit({ moduleActif, compte }: EnTeteCockpitProps) {
  return (
    <>
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
      <h2 className="titre-ecran">{TITRES_ECRAN[moduleActif]}</h2>
    </>
  );
}
