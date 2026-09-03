"use client";

import { ReactNode, useState } from "react";

interface SectionRepliableProps {
  titre: string;
  ouvertParDefaut?: boolean;
  // Par défaut (true), le contenu est démonté du DOM à la fermeture de la section : tout état React
  // local des enfants (useState) est perdu et recréé à neuf à la réouverture. Certaines sections
  // (ex: analyses dont le résultat prend du temps à recalculer) doivent au contraire conserver leur
  // état pendant toute la session du cockpit : passer `demonterAuRepli={false}` garde alors les
  // enfants montés en permanence, simplement masqués via l'attribut HTML `hidden` (aucun accès DOM
  // ni recalcul déclenché par ce masquage — les enfants ne doivent dépendre d'aucun effet de
  // visibilité pour rester compatibles).
  demonterAuRepli?: boolean;
  children: ReactNode;
}

export default function SectionRepliable({
  titre,
  ouvertParDefaut = true,
  demonterAuRepli = true,
  children,
}: SectionRepliableProps) {
  const [ouvert, setOuvert] = useState(ouvertParDefaut);

  return (
    <section className="section-groupe">
      <button
        type="button"
        className="section-titre"
        onClick={() => setOuvert((precedent) => !precedent)}
        aria-expanded={ouvert}
      >
        <span className={`section-titre__chevron${ouvert ? " section-titre__chevron--ouvert" : ""}`}>▾</span>
        {titre}
      </button>
      {demonterAuRepli ? (
        ouvert && <div className="section-contenu">{children}</div>
      ) : (
        <div className="section-contenu" hidden={!ouvert}>
          {children}
        </div>
      )}
    </section>
  );
}
