import type { CSSProperties } from "react";
import type { TankSpecRecord } from "../libs/types";

const DEFAULT_TANK_SPEC: TankSpecRecord = {
  hullColor: "#24f7a7",
  turretOffset: 0.333,
  cannonLength: 0.4,
  turretSize: 0.92,
};

const HULL_LENGTH_RATIO = 1.18;
const HULL_WIDTH_RATIO = 0.62;

type TankAvatarProps = {
  label?: string;
  spec?: TankSpecRecord;
};

export function TankAvatar({ label, spec }: TankAvatarProps) {
  const tankSpec = normalizeTankSpec(spec);

  return (
    <span className="tank-avatar" style={tankSpecStyle(tankSpec)} aria-hidden={!label}>
      <span className="tank-avatar__light tank-avatar__light--front tank-avatar__light--top" />
      <span className="tank-avatar__light tank-avatar__light--front tank-avatar__light--bottom" />
      <span className="tank-avatar__light tank-avatar__light--rear tank-avatar__light--top" />
      <span className="tank-avatar__light tank-avatar__light--rear tank-avatar__light--bottom" />
      <span className="tank-avatar__turret">
        <span className="tank-avatar__barrel" />
        {label ? <span>{label.slice(0, 2).toUpperCase()}</span> : null}
      </span>
    </span>
  );
}

export function normalizeTankSpec(spec: TankSpecRecord | undefined): TankSpecRecord {
  if (!spec) {
    return DEFAULT_TANK_SPEC;
  }

  return {
    hullColor: spec.hullColor || DEFAULT_TANK_SPEC.hullColor,
    turretOffset: clamp(spec.turretOffset, 0.24, 0.66),
    cannonLength: clamp(spec.cannonLength, 0.3, 0.56),
    turretSize: clamp(spec.turretSize, 0.74, 1.06),
  };
}

export function tankSpecStyle(spec: TankSpecRecord): CSSProperties {
  return {
    "--tank-color": spec.hullColor,
    "--turret-offset": `${spec.turretOffset * 100}%`,
    "--turret-size": spec.turretSize,
    "--barrel-length": `${((spec.cannonLength * HULL_LENGTH_RATIO) / (spec.turretSize * HULL_WIDTH_RATIO)) * 100}%`,
  } as CSSProperties;
}

function clamp(value: number, min: number, max: number) {
  if (!Number.isFinite(value)) {
    return min;
  }
  return Math.max(min, Math.min(max, value));
}
