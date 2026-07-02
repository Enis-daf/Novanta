"use client";

import { ReactNode, useState } from "react";

interface SectionRepliableProps {
  titre: string;
  ouvertParDefaut?: boolean;
  children: ReactNode;
}

export default function SectionRepliable({ titre, ouvertParDefaut = true, children }: SectionRepliableProps) {
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
      {ouvert && <div className="section-contenu">{children}</div>}
    </section>
  );
}
