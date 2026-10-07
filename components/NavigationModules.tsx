import Link from "next/link";
import { ROUTE_FUTUR, ROUTE_PASSE } from "@/lib/organizationModules";

interface NavigationModulesProps {
  moduleActif: "passe" | "futur";
  // Entitlement "past" de l'organisation courante : si false, le bouton Passé est absent (jamais
  // affiché désactivé). Futur est toujours visible.
  passeDisponible: boolean;
}

export default function NavigationModules({ moduleActif, passeDisponible }: NavigationModulesProps) {
  const classe = (module: "passe" | "futur") =>
    `btn-secondaire${moduleActif === module ? " btn-module--actif" : ""}`;

  return (
    <>
      {passeDisponible && (
        <Link
          href={ROUTE_PASSE}
          className={classe("passe")}
          aria-current={moduleActif === "passe" ? "page" : undefined}
        >
          Passé
        </Link>
      )}
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
