# Script de cadrage produit — MVP cockpit tactique de trésorerie

Je veux figer le périmètre fonctionnel d’un MVP de cockpit tactique de trésorerie.

Le produit doit être pensé comme un outil de pilotage tactique, précis et opérationnel, pour une entreprise en tension ou en crise de cash.

Il ne doit pas être pensé comme un logiciel de trésorerie stratégique long terme.

La distinction produit est la suivante :

> Les logiciels de trésorerie classiques sont plutôt dans la stratégie.  
> Ce produit est dans la tactique.

Autrement dit :

> Les outils classiques partent souvent d’une vision annuelle ou budgétaire pour extrapoler une vision à 3 mois.  
> Ici, on fait l’inverse : on part du réel opérationnel des 30 prochains jours pour construire une trajectoire de trésorerie quotidienne sur 3 mois.

L’horizon cible du produit est **J+90**.

Tous les calculs, KPIs, visualisations et simulations doivent être centrés sur cette plage de 90 jours.

Le produit doit permettre de répondre à des questions simples et opérationnelles :

- Quel sera mon solde de trésorerie jour par jour sur les 90 prochains jours ?
- Quel est mon point bas de trésorerie sur les 90 prochains jours ?
- À quelle date ma trésorerie passe-t-elle sous zéro ?
- Que se passe-t-il si un client paie avec 7, 15 ou 30 jours de retard ?
- Que se passe-t-il si je décale un paiement fournisseur ?
- Que se passe-t-il si je considère une facture client ou fournisseur comme litigieuse ?
- Quel est l’impact immédiat d’une modification de date de paiement sur ma trajectoire de cash ?

Le produit doit rester très simple.

Il ne doit pas devenir un CRM, un ERP, un outil de relance, un outil achats, ni un logiciel complet de trésorerie.

La philosophie MVP est :

> Une seule chose, bien faite : modifier quelques dates de paiement et voir immédiatement l’impact sur la trésorerie quotidienne à J+90.

---

## Objectif du MVP

Créer un cockpit de trésorerie tactique à 90 jours permettant de :

1. Saisir les principaux flux de trésorerie.
2. Calculer un solde de trésorerie quotidien.
3. Visualiser immédiatement les impacts sur un dashboard.
4. Simuler simplement des modifications de dates de paiement ou d’encaissement.
5. Exclure certaines factures litigieuses des simulations.
6. Voir l’impact immédiat des modifications sur les KPIs et la courbe.

Le produit doit être centré sur la décision opérationnelle, pas sur le reporting financier.

---

## Structure générale de l’écran

L’écran principal doit être divisé en deux zones.

### Zone gauche : dashboard

La partie gauche affiche le dashboard de trésorerie.

Elle doit contenir :

1. Trois KPIs principaux.
2. Une courbe de trésorerie quotidienne.
3. Une mise à jour immédiate dès qu’une variable est modifiée dans la zone de simulation à droite.

Les trois KPIs du MVP sont figés :

1. **Solde projeté à J+90**
2. **Point bas de trésorerie sur les 90 prochains jours**
3. **Date de passage sous zéro sur les 90 prochains jours**

Le seuil critique est **zéro** pour le MVP.

Il ne faut pas prévoir de seuil personnalisable à ce stade.

Si la trésorerie ne passe jamais sous zéro sur la période J+90, afficher une mention claire, par exemple :

> Pas de rupture projetée sur les 90 prochains jours.

La courbe doit afficher l’évolution du solde de trésorerie jour par jour sur les 90 prochains jours.

Le dashboard doit permettre de comprendre instantanément l’impact d’une simulation.

### Zone droite : écran de simulation

La partie droite est l’espace de simulation.

Elle doit afficher les flux sous forme de tableau.

L’utilisateur doit pouvoir voir toutes les factures d’une même nature dans un même écran.

Vues attendues :

- Factures clients
- Factures fournisseurs
- Charges fixes
- Autres dépenses
- Financements

Pour les factures, l’affichage doit être en format tableau :

- une facture par ligne ;
- les variables en colonnes ;
- modification directe dans le tableau ;
- impact immédiat sur le dashboard de gauche.

L’objectif de cette zone n’est pas de créer un outil de gestion complet. C’est uniquement de permettre des modifications tactiques simples et rapides.

---

## Inputs à prévoir

Le MVP doit gérer les catégories d’inputs suivantes.

### 1. Solde bancaire initial

L’utilisateur doit pouvoir renseigner un solde bancaire initial.

Dans le MVP, ce solde peut être saisi manuellement.

Les connexions bancaires pourront être envisagées plus tard, mais elles ne font pas partie du périmètre fonctionnel du MVP.

### 2. Charges fixes

Le produit doit permettre de saisir les charges fixes.

Il s’agit uniquement des charges vraiment fixes, c’est-à-dire les charges qui ne sont pas facilement évitables ou décalables.

Exemples :

- salaires ;
- loyers ;
- charges sociales ;
- remboursements d’emprunts ;
- assurances ;
- abonnements indispensables ;
- autres charges récurrentes réellement fixes.

Ne pas transformer cette partie en module avancé de gestion des coûts.

Les charges fixes doivent être intégrées dans le calcul du solde de trésorerie quotidien.

### 3. Factures clients

Le produit doit gérer les factures clients comme des encaissements attendus.

Pour chaque facture client, le MVP doit prévoir uniquement les informations nécessaires.

Les deux dates importantes sont :

1. **Date d’échéance**
2. **Date d’encaissement anticipée**

Il ne faut pas prévoir plusieurs dates possibles par facture client.

Il ne faut pas prévoir de statut de type :

- à relancer ;
- promis ;
- sécurisé ;
- partiel ;
- en retard ;
- en recouvrement ;
- etc.

Le produit ne doit pas devenir un CRM.

La simulation du retard client doit se faire simplement en modifiant la date d’encaissement anticipée.

Exemple :

- date d’échéance : 10 juillet ;
- date d’encaissement anticipée actuelle : 10 juillet ;
- simulation d’un retard de 15 jours : date d’encaissement anticipée modifiée au 25 juillet.

Pour les factures clients, le tableau doit afficher au minimum :

| Facture | Client | Montant | Date d’échéance | Date d’encaissement anticipée | Facture litigieuse |
|---|---|---:|---|---|---|

La colonne **Facture litigieuse** doit être une case à cocher.

Lorsqu’une facture client est cochée comme litigieuse, elle doit être exclue du calcul de trésorerie.

Elle ne doit pas être supprimée. Elle reste visible dans le tableau, mais elle ne compte plus dans la simulation.

### 4. Factures fournisseurs

Le produit doit gérer les factures fournisseurs comme des décaissements attendus.

Pour le MVP, il ne faut pas ajouter de notions de :

- négociabilité ;
- criticité fournisseur ;
- risque fournisseur ;
- statut de négociation ;
- paiement minimum ;
- fournisseur stratégique ;
- fournisseur bloquant.

On veut éviter toute complexité de type outil achats, outil fournisseurs ou workflow de négociation.

L’objectif est simplement de voir l’impact d’un décalage de paiement fournisseur sur la trésorerie.

Pour chaque facture fournisseur, le tableau doit afficher au minimum :

| Facture | Fournisseur | Montant | Date d’échéance | Date de paiement prévue | Facture litigieuse |
|---|---|---:|---|---|---|

La colonne **Facture litigieuse** doit être une case à cocher.

Lorsqu’une facture fournisseur est cochée comme litigieuse, elle doit être exclue du calcul de trésorerie.

Elle ne doit pas être supprimée. Elle reste visible dans le tableau, mais elle ne compte plus dans la simulation.

### 5. Autres dépenses certaines ou probables

Le produit doit permettre de saisir d’autres dépenses qui ne rentrent pas dans les charges fixes ou les factures fournisseurs.

Ces dépenses doivent pouvoir être classées simplement selon leur niveau de certitude :

- dépense certaine ;
- dépense probable.

Chaque dépense doit avoir au minimum :

- un libellé ;
- un montant ;
- une date prévue ;
- un type : certaine ou probable.

Ces dépenses doivent être intégrées dans le calcul du solde de trésorerie quotidien.

Ne pas complexifier au-delà pour le MVP.

### 6. Financement

Le produit doit permettre d’intégrer des financements entrants.

Exemples :

- dette ;
- prêt ;
- levée de fonds ;
- avance associée ;
- financement relais ;
- autre financement.

Chaque financement doit avoir au minimum :

- un libellé ;
- un montant ;
- une date d’encaissement prévue.

Le financement doit apparaître comme une entrée de trésorerie dans la projection quotidienne.

Ne pas créer de module avancé de financement dans le MVP.

---

## Variables modifiables par facture

Le nombre de variables modifiables par facture doit être très limité.

Pour les factures, l’utilisateur doit pouvoir modifier uniquement :

1. **La date de paiement / encaissement**
2. **La case à cocher “facture litigieuse”**

Pour une facture client :

> La date de paiement correspond à la date d’encaissement anticipée.

Pour une facture fournisseur :

> La date de paiement correspond à la date de décaissement prévue.

La date d’échéance doit être affichée pour donner le contexte, mais elle n’est pas la variable principale de simulation.

Le tableau des factures doit donc toujours distinguer :

- la date d’échéance ;
- la date réellement utilisée dans la simulation de trésorerie.

La date utilisée dans le calcul est :

- la date d’encaissement anticipée pour les factures clients ;
- la date de paiement prévue pour les factures fournisseurs.

La case “facture litigieuse” s’applique aux deux types de factures :

- factures clients ;
- factures fournisseurs.

Une facture litigieuse est exclue du calcul de projection.

Elle reste visible dans le tableau.

---

## Règles de calcul

Le produit doit calculer un solde de trésorerie quotidien sur 90 jours.

Le calcul part du solde bancaire initial.

Chaque jour, le solde est ajusté par :

- les encaissements clients prévus ce jour-là ;
- les financements prévus ce jour-là ;
- les décaissements fournisseurs prévus ce jour-là ;
- les charges fixes prévues ce jour-là ;
- les autres dépenses prévues ce jour-là.

Les factures cochées comme litigieuses doivent être exclues du calcul.

Le résultat attendu est une série quotidienne :

| Date | Solde de trésorerie projeté |
|---|---:|

Cette série quotidienne sert à alimenter :

- la courbe de trésorerie ;
- le solde projeté à J+90 ;
- le point bas de trésorerie sur les 90 prochains jours ;
- la date de passage sous zéro sur les 90 prochains jours.

---

## KPIs

Les KPIs du MVP sont figés.

### 1. Solde projeté à J+90

Afficher le solde de trésorerie projeté à la fin de la période de 90 jours.

### 2. Point bas de trésorerie sur les 90 prochains jours

Afficher le solde minimum atteint sur la période J+90.

Ce KPI doit toujours être calculé sur toute la période de 90 jours.

### 3. Date de passage sous zéro sur les 90 prochains jours

Afficher la première date à laquelle la trésorerie projetée passe sous zéro.

Le seuil est zéro.

Il n’y a pas de seuil personnalisable dans le MVP.

Si la trésorerie ne passe jamais sous zéro, afficher une mention claire :

> Pas de passage sous zéro sur les 90 prochains jours.

---

## Simulations à prévoir

Le MVP doit permettre des simulations simples, rapides et visibles immédiatement.

### 1. Décaler un encaissement client

L’utilisateur doit pouvoir modifier la date d’encaissement anticipée d’une facture client.

Le dashboard doit se mettre à jour immédiatement.

Cas d’usage :

> Que se passe-t-il si mon client paie avec 7, 15 ou 30 jours de retard ?

Le produit peut prévoir des actions rapides de type :

- +7 jours ;
- +15 jours ;
- +30 jours.

Mais le cœur du MVP reste simplement la possibilité de modifier manuellement la date d’encaissement anticipée.

### 2. Décaler un paiement fournisseur

L’utilisateur doit pouvoir modifier la date de paiement prévue d’une facture fournisseur.

Le dashboard doit se mettre à jour immédiatement.

Cas d’usage :

> Que se passe-t-il si je décale ce paiement fournisseur de 15 jours ?

### 3. Exclure une facture litigieuse

L’utilisateur doit pouvoir cocher une facture comme litigieuse.

Cette fonctionnalité s’applique aux deux types de factures :

- factures clients ;
- factures fournisseurs.

Une facture litigieuse doit être exclue de la projection.

Elle ne doit pas être supprimée.

Elle reste visible dans le tableau, avec son état litigieux clairement affiché.

Cas d’usage côté client :

> Cette facture client est incertaine ou contestée, je veux voir ma trajectoire de cash sans la compter.

Cas d’usage côté fournisseur :

> Cette facture fournisseur est contestée ou incertaine, je veux voir ma trajectoire de cash sans l’intégrer au décaissement prévu.

---

## Scénario “je ne paie mes fournisseurs que quand mes clients ont payé”

Cette règle ne doit pas être implémentée dans le MVP.

Elle sera simulée manuellement par l’utilisateur au début.

Concrètement, l’utilisateur pourra modifier lui-même les dates de paiement fournisseur dans le tableau pour reproduire cette logique.

Ne pas créer de règle automatique.

Ne pas créer de moteur de dépendance entre factures clients et factures fournisseurs.

Ne pas créer de rapprochement client/fournisseur.

Ne pas créer de scénario global automatisé à ce stade.

---

## Ce que le MVP ne doit pas faire

Ne pas ajouter de CRM.

Ne pas ajouter de statuts avancés sur les factures clients.

Ne pas ajouter de pipeline de relance.

Ne pas ajouter de criticité fournisseur.

Ne pas ajouter de risque fournisseur.

Ne pas ajouter de statut de négociation fournisseur.

Ne pas ajouter de paiement minimum fournisseur.

Ne pas ajouter de workflow fournisseur.

Ne pas ajouter de gestion documentaire.

Ne pas ajouter de workflow d’approbation.

Ne pas ajouter de prévisionnel annuel.

Ne pas partir d’un budget annuel pour construire le 90 jours.

Ne pas créer un logiciel complet de trésorerie stratégique.

Ne pas multiplier les variables par facture.

Ne pas créer de seuil critique personnalisable dans le MVP.

Ne pas créer de règle automatique “je paie mes fournisseurs uniquement quand mes clients ont payé”.

Ne pas créer de lien automatique entre encaissements clients et paiements fournisseurs.

Ne pas complexifier les inputs au-delà du nécessaire.

---

## Expérience attendue

L’utilisateur doit pouvoir arriver sur l’écran principal et comprendre immédiatement :

1. son solde de trésorerie projeté à J+90 ;
2. son point bas sur les 90 prochains jours ;
3. sa date éventuelle de passage sous zéro ;
4. l’évolution quotidienne de sa trésorerie ;
5. l’impact immédiat d’un décalage d’encaissement ;
6. l’impact immédiat d’un décalage de paiement ;
7. l’impact immédiat de l’exclusion d’une facture litigieuse.

L’expérience doit être très directe.

Le produit doit donner une sensation de cockpit de crise :

> Je vois la trajectoire.  
> Je modifie une date.  
> Je coche une facture litigieuse.  
> Je vois immédiatement le résultat.  
> Je peux arbitrer.

---

## Critères d’acceptation MVP

Le MVP est réussi si l’utilisateur peut :

1. Renseigner un solde bancaire initial.
2. Ajouter des charges fixes.
3. Ajouter des factures clients avec montant, date d’échéance et date d’encaissement anticipée.
4. Ajouter des factures fournisseurs avec montant, date d’échéance et date de paiement prévue.
5. Ajouter d’autres dépenses certaines ou probables.
6. Ajouter des financements entrants.
7. Voir un solde de trésorerie quotidien sur les 90 prochains jours.
8. Voir une courbe de trésorerie quotidienne.
9. Voir le solde projeté à J+90.
10. Voir le point bas de trésorerie sur les 90 prochains jours.
11. Voir la première date de passage sous zéro sur les 90 prochains jours.
12. Modifier la date d’encaissement anticipée d’une facture client.
13. Modifier la date de paiement prévue d’une facture fournisseur.
14. Cocher une facture client comme litigieuse.
15. Cocher une facture fournisseur comme litigieuse.
16. Voir les factures litigieuses rester visibles mais exclues du calcul.
17. Voir le dashboard se mettre à jour immédiatement après chaque modification.
18. Simuler un retard client de 7, 15 ou 30 jours en modifiant la date d’encaissement anticipée.
19. Simuler un décalage de paiement fournisseur en modifiant la date de paiement prévue.
20. Voir toutes les factures d’une même nature dans un tableau unique sur l’écran de droite.
21. Simuler manuellement une logique “je ne paie mes fournisseurs que quand mes clients ont payé” en ajustant lui-même les dates de paiement fournisseur.

---

## Résumé fonctionnel à garder en tête

Le MVP est un cockpit tactique de trésorerie à 90 jours.

Il repose sur :

- un solde bancaire initial ;
- des charges fixes ;
- des factures clients ;
- des factures fournisseurs ;
- d’autres dépenses certaines ou probables ;
- des financements entrants.

Il produit :

- un solde quotidien de trésorerie sur 90 jours ;
- une courbe de trésorerie ;
- trois KPIs : solde à J+90, point bas, date de passage sous zéro.

Il permet de simuler :

- un retard client ;
- un décalage fournisseur ;
- l’exclusion d’une facture litigieuse.

Il ne cherche pas à tout gérer.

Il cherche à répondre à une seule question :

> Que se passe-t-il sur ma trésorerie à 90 jours si je modifie une date de paiement ou si j’exclus une facture incertaine ?
