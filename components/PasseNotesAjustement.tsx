// Réserves attachées à un ajustement de gestion (par exemple une périodisation incertaine) :
// discrètes mais visibles partout où l'ajustement est montré. Plusieurs ajustements regroupés
// peuvent en porter plusieurs : la première est affichée, les autres sont comptées.
export default function PasseNotesAjustement({ notes }: { notes: string[] }) {
  if (notes.length === 0) return null;
  return (
    <p className="passe-reserve">
      {notes[0]}
      {notes.length > 1 && ` (+ ${notes.length - 1} autre${notes.length > 2 ? "s" : ""} du même type)`}
    </p>
  );
}
