"use client";

interface BarreRechercheProps {
  valeur: string;
  onChange: (valeur: string) => void;
  placeholder?: string;
}

export default function BarreRecherche({ valeur, onChange, placeholder = "Rechercher une facture, un tiers, une dépense…" }: BarreRechercheProps) {
  return (
    <div className="barre-recherche">
      <input
        type="text"
        className="barre-recherche__input"
        placeholder={placeholder}
        aria-label={placeholder.replace(/…$/, "")}
        value={valeur}
        onChange={(e) => onChange(e.target.value)}
      />
      {valeur && (
        <button
          type="button"
          className="barre-recherche__effacer"
          onClick={() => onChange("")}
          aria-label="Effacer la recherche"
        >
          ×
        </button>
      )}
    </div>
  );
}
