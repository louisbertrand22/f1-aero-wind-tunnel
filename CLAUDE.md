# AeroLab — Soufflerie virtuelle F1 (CFD 2D)

Banc d'essai aérodynamique temps réel dans le navigateur : solveur Lattice Boltzmann D2Q9 dans un Web Worker, rendu Canvas 2D, interface de télémétrie React. UI en français.

## Commandes

```bash
npm install          # dépendances
npm run dev          # serveur Vite (http://localhost:5173)
npm run build        # tsc --noEmit puis bundle (app + worker ES module)
npm run typecheck    # npx tsc --noEmit
npm test             # vitest run (physique + géométrie)
npx vitest run src/physics   # un seul dossier
```

Toujours faire passer `npm test`, `npx tsc --noEmit` et `npm run build` avant de livrer.

## Architecture

```
src/
  types.ts                  contrat partagé (TunnelParams, Telemetry, ViewSettings…) + conventions de grille
  physics/
    lbmSolver.ts            solveur D2Q9 BGK + Smagorinsky, CL, forces par échange de quantité de mouvement
    smoke.ts                colorant passif (advection semi-lagrangienne), râteau de buses
    flowVis.ts              peinture flow-vis accumulée sur la peau du corps (∝ cisaillement²)
    units.ts                pont lattice ↔ SI, filtre de forces, calcul de la télémétrie
  geometry/
    presets.ts              description statique des 4 configurations (plages, échelles, défauts)
    airfoils.ts             NACA 4 chiffres, polygones des profils, rastériseur, pinceau
  workers/
    protocol.ts             messages UI ↔ worker, pool de tampons transférables
    cfd.worker.ts           boucle de simulation (sous-pas, DRS, géométrie, télémétrie)
  hooks/useCfdWorker.ts     cycle de vie du worker, ping-pong des tampons, historique
  lib/                      colormaps (LUT OKLab), fieldRenderer (bilinéaire), particles, history, format
  components/               WindTunnelCanvas, TelemetryHeader, ControlSidebar, HistoryChart, ABComparator, ui/
```

### Conventions de grille (à respecter partout)

- Cellule `(i, j)`, `idx = i + j * nx`. `i` croît vers l'aval, **`j` croît vers le bas** (`j = 0` plafond, `j = ny-1` route).
- Les centres de cellule sont aux coordonnées entières ; la surface de la route est à `y = ny - 1.5`.
- Unités lattice : `dx = dt = 1`, `ρ₀ = 1`, `cs² = 1/3`, pression `p = ρ/3`.
- Une force `fy > 0` pointe vers la route : c'est de l'**appui**. `fx > 0` est de la traînée.

### Solveur (`physics/lbmSolver.ts`)

- D2Q9, collision BGK, viscosité de sous-maille Smagorinsky (τ local) pour tenir les bas ν.
- Entrée en vitesse imposée (+ sillage synthétique « air sale »), sortie non réfléchissante avec zone éponge, plafond free-slip, bas = tapis roulant (`movingWall`) ou free-slip.
- Corps : bounce-back à mi-lien. Forces intégrées par **échange de quantité de mouvement** sur les liens fluide→corps ; `takeForces()` renvoie la moyenne par pas (`fx`, `fy`, `xFy` pour le centre de poussée).
- `setSolid(mask)` gère les géométries mobiles (DRS, pinceau) : cellules libérées ré-initialisées à l'équilibre.
- Aucune allocation dans `step()` ; ne pas introduire de closures ni d'objets dans la boucle chaude.

### Passage aux unités SI (`physics/units.ts`)

Le Reynolds réel (~10⁶) n'est pas résoluble en 2D temps réel : la veine tourne à Reynolds réduit et les efforts passent par **similitude**. `C = F_lattice / (½ ρ u² L_cells)` puis `F = C · ½ ρ_air V² · (corde × envergure × k3d)` avec les références de `geometry/presets.ts`. Vitesse km/h → `u_lattice ∈ [0.035, 0.085]`, viscosité (×10⁻⁵ m²/s) → `ν_lattice = 0.004·ν`. La garde au sol est en « mm virtuels » (`rideMmPerCell`), échelle verticale volontairement dilatée sur le fond plat.

### Protocole Web Worker (`workers/protocol.ts`)

UI → worker :
- `init { nx, ny, params }` — (re)crée la veine ; un changement de grille recrée le worker.
- `setParams { params }` — `TunnelParams` complet à chaque modification.
- `paint { x0, y0, x1, y1, radius, erase }` — segment de pinceau en coordonnées grille (preset `freeform`).
- `command { command }` — `resetFlow | clearSculpt | resetFlowVis | clearSmoke`.
- `recycle { buffers }` — rend un jeu de tampons au pool (transfert).

Worker → UI :
- `ready { nx, ny }`
- `frame { frameId, nx, ny, buffers, telemetry, perf, outlines, drs }` — `buffers` = `ux, uy, rho, curl, smoke (RGB), flowVis` en `Float32Array` + `solid` en `Uint8Array`, tous **transférés** (zéro copie).
- `error { message }`

Le worker possède un pool de 3 `FrameBuffers`. Chaque `frame` en cède un ; l'UI **doit** renvoyer le précédent via `recycle` dès qu'une nouvelle image le remplace (fait dans `useCfdWorker`). Pool vide ⇒ la physique continue, la publication est sautée. Un tampon transféré est détaché : ne jamais conserver de référence à `frame.buffers` au-delà de l'image courante.

Boucle (`cfd.worker.ts`) : ~60 ticks/s, `params.substeps` pas lattice par tick bornés par un budget de ~11 ms (dégradation de la vitesse de simulation, jamais de l'UI). Divergence détectée (`isFinite()`) ⇒ reset automatique + `telemetry.stable = false`.

### Rendu

`WindTunnelCanvas` lit `frameRef` dans `requestAnimationFrame` (jamais via l'état React). `FieldRenderer` interpole la **donnée** en bilinéaire à 2× la grille avant la LUT, en excluant les cellules solides près des parois. Seule la télémétrie (~12 Hz) passe par `useState` ; l'historique vit dans un `HistoryBuffer` hors React.

## Règles de style

- TypeScript strict, `verbatimModuleSyntax` : `import type` pour les types. Pas de `any`.
- Tokens de design dans `src/index.css` (`@theme`) : carbone, encre, accent `flowvis` réservé au chrome ; couleurs `series-*` réservées aux données ; `gain/loss/warn` toujours avec icône + libellé.
- Valeurs vivantes en `.num` (mono tabulaire), micro-labels en `.label-cond`.
