# AeroLab — Banc d'essai aérodynamique & soufflerie virtuelle F1 (CFD 2D)

Soufflerie numérique temps réel dans le navigateur : solveur **Lattice Boltzmann D2Q9** exécuté dans un Web Worker, rendu scientifique Canvas à 60 FPS et tableau de bord de télémétrie façon pit-wall.

```bash
npm install
npm run dev      # http://localhost:5173
```

## Fonctionnalités

- **Configurations** : aileron arrière bi-plan avec volet DRS mobile, aileron avant 4 éléments en effet de sol, fond plat & diffuseur Venturi sur tapis roulant, sculpture libre (pinceau / gomme).
- **Calques** : pression Cp, vélocité |V|, vorticité ∇×V, fumée colorée & lignes de courant (traceurs lagrangiens).
- **Télémétrie** : appui (N, kgf), traînée, finesse, centre de poussée, Reynolds, Mach, historique glissant.
- **Outils d'écurie** : simulateur d'air sale, comparateur A/B (run de référence), sonde Pitot au survol, peinture Flow-Vis.

## Raccourcis clavier

| Touche | Action |
|---|---|
| `D` | Ouvrir / fermer le DRS |
| `1` – `4` | Pression · Vélocité · Vorticité · Fumée |
| `Espace` | Pause / reprise |
| `R` | Réinitialiser l'écoulement |
| `B` | Enregistrer le run de référence |
| `F` | Peinture Flow-Vis |
| `A` | Air sale |

## Scripts

| Commande | Rôle |
|---|---|
| `npm run dev` | Serveur de développement Vite |
| `npm run build` | Vérification de types + bundle de production |
| `npm test` | Tests unitaires (stabilité du solveur, géométrie) |
| `npm run typecheck` | `tsc --noEmit` |

## Limites du modèle

Simulation 2D à Reynolds réduit : les efforts affichés en newtons sont obtenus par similitude à partir des coefficients calculés sur la grille (voir `CLAUDE.md`). Les tendances (effet du DRS, de la garde au sol, de l'angle de diffuseur, de l'air sale) sont représentatives ; les valeurs absolues ne remplacent pas une CFD 3D ni un essai en soufflerie.
