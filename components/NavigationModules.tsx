import Link from "next/link";
import { ROUTE_ACTION, ROUTE_FUTUR, ROUTE_PASSE } from "@/lib/organizationModules";

export type ModuleCockpit = "passe" | "action" | "futur";

interface NavigationModulesProps {
  moduleActif: ModuleCockpit;
  // Entitlement "past" de l'organisation courante : si false, aucun bouton n'est affiché (jamais
  // de bouton désactivé, et pas de bouton "Futur" seul sans rien vers quoi basculer). Action lit
  // les données du module Passé : il suit le même entitlement.
  passeDisponible: boolean;
}

// Passé → Action → Futur : ce qu'on observe, ce qu'on décide de changer, ce qu'on en projette.
const MODULES: { cle: ModuleCockpit; libelle: string; route: string }[] = [
  { cle: "passe", libelle: "Passé", route: ROUTE_PASSE },
  { cle: "action", libelle: "Action", route: ROUTE_ACTION },
  { cle: "futur", libelle: "Futur", route: ROUTE_FUTUR },
];

export default function NavigationModules({ moduleActif, passeDisponible }: NavigationModulesProps) {
  if (!passeDisponible) return null;

  return (
    <nav className="nav-modules selecteur" aria-label="Modules">
      {MODULES.map((module) => (
        <Link
          key={module.cle}
          href={module.route}
          className={`btn-secondaire${moduleActif === module.cle ? " btn-module--actif" : ""}`}
          aria-current={moduleActif === module.cle ? "page" : undefined}
        >
          {module.libelle}
        </Link>
      ))}
    </nav>
  );
}
