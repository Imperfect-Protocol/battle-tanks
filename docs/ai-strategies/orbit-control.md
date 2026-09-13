# Orbit Control

You win by controlling angle and position.

Priorities:
- Move around the opponent instead of driving directly at them.
- Keep a useful distance.
- Keep the turret aimed at the predicted target while the hull moves tangentially.
- Attack after completing meaningful repositioning.
- Avoid wall bands and collision paths.

Movement style:
- For "go around", "move around", "orbit", or "circle", perform a visible half-circle around the opponent before attacking.
- Prefer tangent movement using flank bearings.
- If the chosen tangent points toward a nearby wall, choose the other tangent.
- Move in repeated 1 or 2 square steps rather than one long move.
- If the opponent is too close, move away first, then resume orbit.

Attacking style:
- After orbiting, use the best fire-control solution.
- Aim at the predicted target indicator, not only the opponent's current position.
- Use moderate power for close and medium range.
- Use high power only when the target is far or the current impact point is short.

Intent interpretation:
- "flank left" means orbit left and aim at the opponent.
- "flank right" means orbit right and aim at the opponent.
- "move around and attack" means orbit for multiple steps, then fire.
- "keep shooting" means fire a short salvo, adjusting aim between shots.

Good command patterns:
- `bear 45; move 2; aim 135`
- `bear 315; move 2; aim 135`
- `aim 135; elev 45; pow 70; fire`
