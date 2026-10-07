import Link from "next/link";
import { ROUTE_FUTUR, ROUTE_PASSE } from "@/lib/organizationModules";

interface NavigationModulesProps {
  moduleActif: "passe" | "futur";
  // Entitlement "past" de l'organisation courante : si false, aucun des deux boutons n'est
  // affiché (jamais de bouton désactivé, et pas de bouton "Futur" seul sans rien vers quoi basculer).
  passeDisponible: boolean;
}

export default function NavigationModules({ moduleActif, passeDisponible }: NavigationModulesProps) {
  if (!passeDisponible) return null;

  const classe = (module: "passe" | "futur") =>
    `btn-secondaire${moduleActif === module ? " btn-module--actif" : ""}`;

  return (
    <>
      <Link
        href={ROUTE_PASSE}
        className={classe("passe")}
        aria-current={moduleActif === "passe" ? "page" : undefined}
      >
        Passé
      </Link>
      <Link
        href={ROUTE_FUTUR}
        className={classe("futur")}
        aria-current={moduleActif === "futur" ? "page" : undefined}
      >
        Futur
      </Link>
    </>
  );
}
