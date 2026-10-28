import Link from "next/link";
import IconCadenas from "@/components/IconCadenas";
import { Capacite, LIBELLES_OFFRES, messageOffreRequise, Offre } from "@/lib/offres";

interface OffreVerrouilleeProps {
  capacite: Capacite;
  // Sujet de la phrase, avec son article : « La projection de trésorerie », « Le BFR »…
  fonctionnalite: string;
  offreActuelle: Offre;
  // Où aller à la place (ex. le module Passé quand Futur est verrouillé).
  lien?: { href: string; libelle: string };
}

// Écran affiché à la place d'une fonctionnalité que l'offre de l'organisation n'inclut pas. Nomme
// l'offre nécessaire, sans parcours d'achat : en V1, l'offre est attribuée par l'équipe Novanta.
export default function OffreVerrouillee({ capacite, fonctionnalite, offreActuelle, lien }: OffreVerrouilleeProps) {
  return (
    <section className="offre-verrou" role="status">
      <p className="offre-verrou__offre">
        <IconCadenas />
        {messageOffreRequise(capacite)}
      </p>
      <p className="offre-verrou__texte">
        {fonctionnalite} ne fait pas partie de votre offre {LIBELLES_OFFRES[offreActuelle]}. Pour y accéder, contactez
        l&apos;équipe Novanta.
      </p>
      {lien && (
        <Link href={lien.href} className="btn-secondaire offre-verrou__lien">
          {lien.libelle}
        </Link>
      )}
    </section>
  );
}
