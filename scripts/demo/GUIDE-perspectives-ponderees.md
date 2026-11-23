# Démonstration — Perspectives pondérées (offre Pilotage)

Compte : **Compte démo** (société `9d5170e6-019f-41ae-9782-c86085cb59cd`, offre Pilotage).
Où : **Preview de la PR #44** — https://novanta-git-feature-prevision-probabiliste-novanta.vercel.app — connecté avec le compte propriétaire du « Compte démo ».
Chemin : en-tête **Futur** → onglet **Perspectives pondérées**.

Toutes les données de la démonstration sont fictives. Tous les libellés sont lisibles, sans marque de démonstration (factures FA-2026-101 Atelier Aurore…, charges « Paie », rentrée « Contrats récurrents »…). Les lignes Futur qui existaient déjà dans le compte ont été mises de côté (À couper, Versé, Payée…) et sont rétablies à la demande.

**Message à faire passer :** « Nous identifions les encaissements dont dépend votre trésorerie, nous voyons quand leur retard créerait un déficit et nous pouvons tester une réponse avant d'être dans l'urgence. »

## Calendrier (J0 = vendredi 20 novembre 2026, date du relevé)

| | Date | Flux de référence |
|---|---|---:|
| J0 | 20 nov. 2026 | Solde du relevé : **35 000 €** |
| J1 | 21 nov. 2026 | Facture **FA-2026-101** — Atelier Aurore : +20 000 € (échéance contractuelle déjà passée, le 8 nov. ; encaissement actualisé au 21 nov.) |
| J10 | 30 nov. 2026 | Facture **FA-2026-102** — Studio Boréal : +15 000 € |
| J11 | 1er déc. 2026 | Paie : −45 000 € |
| J15 | 5 déc. 2026 | Échéances sociales et fiscales : −15 000 € |
| J20 | 10 déc. 2026 | Facture **FA-2026-104** — Groupe Rivage : +50 000 € (reste dû d'une facture de 80 000 € dont 30 000 € déjà encaissés avant J0, donc dans le solde) |
| J25 | 15 déc. 2026 | Fournisseurs du mois : −35 000 € |
| J35 | 25 déc. 2026 | Contrats récurrents : +18 000 €/mois (**à renseigner**) |
| J40 | 30 déc. 2026 | Équipe existante : −22 000 €/mois |
| J42 | 1er janv. 2027 | Frais de structure : −4 000 €/mois |
| J44 | 3 janv. 2027 | Recrutement conditionnel : −4 500 €/mois, seulement si le CA du mois précédent dépasse 60 000 € |
| J47 | 6 janv. 2027 | Financement potentiel : +12 000 € (**à renseigner**) |
| J50 | 9 janv. 2027 | Équipement : −9 000 € (**à renseigner**) |
| J60 | 19 janv. 2027 | Acompte d'un projet non signé (facture prévisionnelle, Nova Horizon) : +8 000 €, probabilité 75 % |
| J90 | 18 févr. 2027 | Fin de l'horizon (90 jours) |

Référence (vérifiée sur les données en base) : **25 000 €** le 1er déc. · **10 000 €** le 5 déc. (point bas) · **25 000 €** le 15 déc. La projection reste positive sur les 90 jours.

## Parcours (8 à 10 minutes)

### 1. Lire la projection de référence
- **Où :** Futur → **Perspectives pondérées**.
- **À voir :** le bandeau « Prévision probabiliste indisponible — 1 hypothèse importante doit être renseignée. », puis le bloc **Gestion des risques** et la cartouche **« 3 hypothèses à renseigner »**.
- **À dire :** la projection telle que saisie reste positive (point bas 10 000 € le 5 déc.) — et pourtant elle dépend de quelques encaissements.

### 2. Compléter les hypothèses
- **Où :** section **Hypothèses de la prévision** → cliquer la cartouche « 3 hypothèses à renseigner » (filtre activé), ou le filtre **À renseigner** ; montrer aussi la recherche (taper « Contrats »).
- **Contrats récurrents** (rentrée régulière) → **Renseigner** : au-dessus des choix, **Montant prévu 18 000 € par échéance** et **Début prévu 25 déc. 2026**.
  Choisir : Probabilité **Certain (100 %)** · Montant cible **18000** · Certitude du montant **Approximatif** (affiche « 8 fois sur 10 entre 13 500 € et 22 500 € par échéance ») · Certitude de la date de début **Ferme**.
  Montrer que la ligne reste affichée pendant les réglages, puis cliquer le bouton rose **Enregistrer** : elle quitte le filtre seulement après « Hypothèse enregistrée ».
- **Financement potentiel** → **Renseigner** : Probabilité **Incertain (25 %)** · Certitude du montant **Certain** · Certitude de la date **Approximative** → **Enregistrer**.
- **Équipement** → **Renseigner** : Probabilité **Possible (50 %)** · Certitude du montant **Certain** · Certitude de la date **Assez fiable** → **Enregistrer**.
- **À dire :** on choisit une certitude en voyant toujours la valeur à laquelle elle s'applique ; montant et date sont deux incertitudes distinctes.

### 3. Lire les perspectives pondérées (Monte Carlo)
- **À voir** (10 000 scénarios, valeurs calculées sur le jeu) : **Risque de passer sous 0 € : 97 %** avant le 18 févr. 2027 · **Point bas probable −34 218 €**, 8 cas sur 10 entre −44 965 € et −10 000 € · courbe médiane rose et bande grise (8 cas sur 10).
- Jours clés (P10 / médiane / P90) : 1er déc. −10 000 / 10 000 / 25 000 € · 5 déc. −10 000 / −5 000 / 10 000 € · 15 déc. −40 000 / −25 000 / 25 000 €.
- **À dire :** la projection saisie est positive, mais les habitudes de paiement réelles des clients (Groupe Rivage paie souvent 1 à 2 mois après l'échéance) rendent une tension de trésorerie très probable. Le recrutement conditionnel n'est déclenché que dans 20 % des scénarios : quand D glisse en janvier, le CA de décembre passe sous 60 000 €.
- Les pourcentages sont des estimations Monte Carlo ; les montants des étapes 4 à 6 sont des stress déterministes exacts.

### 4. Ouvrir l'alerte du duo
- **Où :** Gestion des risques → carte **« Le retard simultané de ces deux factures peut faire passer votre trésorerie sous zéro le 01 déc. 2026. »**
- **À voir :** FA-2026-101 (Atelier Aurore) : prévu le 21 nov., testé le 2 déc. (+11 jours) · FA-2026-102 (Studio Boréal) : prévu le 30 nov., testé le 2 déc. (+2 jours) · **Tension le 01 déc. 2026 · déficit 10 000 € · 1 jour sous zéro** · « Ce jour-là sont aussi prévus : Paie (45 000 €) ».
- **Voir les 2 factures** : reste à encaisser, dates de référence et dates testées.
- **À dire :** aucune des deux factures n'est dangereuse seule à ces dates ; ensemble, elles créent un déficit à couvrir de 10 000 € le jour de la paie.

### 5. Comparer les quatre situations
- **Où :** même carte → **Voir l'impact sur la courbe**.
- **À voir :** Référence point bas 10 000 € · A seule retardée 5 000 € · B seule retardée 10 000 € · Les deux retardées **−10 000 €** le 1er déc. ; courbes lissées, infobulles aux valeurs exactes.
- **À dire :** recevoir l'un des deux règlements à temps suffit à éviter le creux.

### 6. Ouvrir la facture D (encaissement critique)
- **Où :** Gestion des risques → carte « Un retard sur cette facture peut faire passer votre trésorerie sous zéro. » (FA-2026-104, Groupe Rivage).
- **À voir :** reste à encaisser **50 000 €**, encaissement prévu le 10 déc., « Un paiement après le 15 déc. 2026 provoquerait une tension » · **Tension le 15 déc. 2026 · déficit 25 000 €**.
- **À dire :** le déficit à couvrir est de 25 000 € — pas les 50 000 € restant dus, ni les 80 000 € facturés. Si D arrivait le 18 déc., le compte resterait à −25 000 € du 15 au 17 déc., puis remonterait à 25 000 €. L'alerte montre le premier jour de retard qui crée la tension (paiement le 16 déc.).
- Autre carte visible : « Deux factures présentent chacune un risque… » le 5 déc. (A ou B payée après le 5 déc. suffit à elle seule).

### 7. Agir avant la tension : un financement confirmé
- **Où :** onglet **Flux de tréso** → section **Financements** → **+ Ajouter un financement**.
- Saisir : Libellé **Financement confirmé** (exactement, pour que la remise à l'état initial le retrouve) · Montant **30000** · Date d'encaissement prévue **28/11/2026** · Versé : non.
- Revenir sur **Perspectives pondérées** : la ligne apparaît « À renseigner · important » → **Renseigner** → Probabilité **Certain**, Certitude du montant **Certain**, Certitude de la date **Ferme** → **Enregistrer**.
- **À voir :** l'alerte du duo A + B disparaît (même stress : point bas **+20 000 €** au lieu de −10 000 €) ; la facture D n'est plus critique au 15 déc. (même stress : **+5 000 €** au lieu de −25 000 €). Risque Monte Carlo : 71 % au lieu de 97 %. Restent des tensions plus tardives (duos avec D le 15 et le 30 déc., D seule si elle est payée après le 1er janv.).
- **À dire :** une ressource disponible avant la tension couvre les deux scénarios testés ; passer une date en « Ferme » n'aurait rien changé au risque structurel.

### 8. Revenir à l'état initial
Demander à Claude : **« Remets la démo Pilotage à l'état initial. »** Le financement ajouté (libellé « Financement confirmé ») et les hypothèses saisies sont retirés, les trois hypothèses redeviennent « À renseigner », les dates du noyau sont rétablies. Rien d'autre n'est modifié.

## À savoir
- **Ne pas cliquer « Synchroniser Pennylane »** dans Flux de tréso pendant la démonstration : la synchronisation pourrait réactiver des factures existantes mises de côté.
- Gestion des risques affiche « **Analyse partielle** » (limite « Méthode ») : le recrutement dépend d'une condition, les duos sont donc testés à leurs retards minimaux. C'est le comportement attendu, pas une erreur.
- Le « CA du mois précédent » du moteur correspond aux encaissements clients prévus du mois, à leur date de référence (pas au chiffre d'affaires comptable).
- Réancrage (nouvelle date de démonstration) : demander « Réancre la démo Pilotage à aujourd'hui ». Retrait complet (rétablit les données existantes du compte) : « Retire la démo Pilotage ».
