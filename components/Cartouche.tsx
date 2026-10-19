// Cartouche, comme sur un plan : le contexte de lecture de l'écran (relevé, période, lecture des
// montants…) regroupé dans un bloc en bas du panneau. N'ajoute aucune information nouvelle.
export interface LigneCartouche {
  libelle: string;
  valeur: string;
}

export default function Cartouche({ titre, lignes }: { titre: string; lignes: LigneCartouche[] }) {
  return (
    <aside className="cartouche" aria-label={`Cartouche — ${titre}`}>
      <p className="cartouche__titre">{titre}</p>
      <dl className="cartouche__lignes">
        {lignes.map((ligne) => (
          <div key={ligne.libelle} className="cartouche__ligne">
            <dt>{ligne.libelle}</dt>
            <dd>{ligne.valeur}</dd>
          </div>
        ))}
      </dl>
    </aside>
  );
}
