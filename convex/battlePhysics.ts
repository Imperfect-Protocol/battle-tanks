import {
  BOARD_SIZE,
  MAX_AIM_ELEVATION_DEGREES,
  MAX_FIRE_POWER,
  MIN_AIM_ELEVATION_DEGREES,
  MIN_FIRE_POWER,
  TANK_COLLISION_RADIUS_UNITS,
  TANK_LENGTH_UNITS,
  TANK_WIDTH_UNITS,
  UNITS_PER_SQUARE,
  clamp,
  distanceBetween,
  normalizeDegrees,
  normalizeTankSpec,
  roundForStorage,
  vectorFromBearing,
} from "./gameCore";

export const PROJECTILE_HIT_RADIUS_UNITS = 750;
export const PROJECTILE_GRAVITY_UNITS = 48;
export const MAX_PROJECTILE_DAMAGE = 35;
export const MIN_PROJECTILE_DAMAGE = 4;
export const COLLISION_DAMAGE_PER_SPEED = 0.18;
export const MAX_COLLISION_DAMAGE = 45;
export const FRAME_MS = 40;

const NORMAL_IQR_WIDTH_IN_SIGMA = 1.3489795003921634;
const PROJECTILE_DAMAGE_SIGMA = PROJECTILE_HIT_RADIUS_UNITS / NORMAL_IQR_WIDTH_IN_SIGMA;
const LAUNCH_RANGE_BY_ANGLE: Record<number, number> = {
  30: 8 * UNITS_PER_SQUARE,
  45: 6 * UNITS_PER_SQUARE,
  60: 4 * UNITS_PER_SQUARE,
};

type Vector = {
  x: number;
  y: number;
};

type TankState = {
  position: Vector;
  velocity: Vector;
  hullDirection: number;
  turretDirection: number;
  launchAngle?: number;
  cannonPower?: number;
  lastFirePower?: number;
  tankSpec?: unknown;
};

export class ProjectilePhysics {
  fullPowerRange(angle: number) {
    if (angle <= 30) {
      return LAUNCH_RANGE_BY_ANGLE[30];
    }
    if (angle <= 45) {
      return this.interpolate(angle, 30, LAUNCH_RANGE_BY_ANGLE[30], 45, LAUNCH_RANGE_BY_ANGLE[45]);
    }
    return this.interpolate(angle, 45, LAUNCH_RANGE_BY_ANGLE[45], 60, LAUNCH_RANGE_BY_ANGLE[60]);
  }

  launchVelocity(power: number, elevation: number) {
    const launchAngle = clamp(elevation, MIN_AIM_ELEVATION_DEGREES, MAX_AIM_ELEVATION_DEGREES);
    const radians = (launchAngle * Math.PI) / 180;
    const targetRange = this.fullPowerRange(launchAngle) * (clamp(power, MIN_FIRE_POWER, MAX_FIRE_POWER) / 100);
    const launchSpeed = Math.sqrt(targetRange * PROJECTILE_GRAVITY_UNITS / Math.sin(2 * radians));
    return {
      horizontal: Math.cos(radians) * launchSpeed,
      vertical: Math.sin(radians) * launchSpeed,
    };
  }

  impactFromTank(tank: TankState, boardSize = BOARD_SIZE) {
    const elevation = tank.launchAngle ?? 45;
    const power = tank.cannonPower ?? tank.lastFirePower ?? 100;
    const launch = this.launchVelocity(power, elevation);
    const horizontalVelocity = vectorFromBearing(tank.turretDirection, launch.horizontal);
    const muzzle = this.muzzlePosition(tank, boardSize);

    return this.impactPoint(muzzle, horizontalVelocity, launch.vertical, boardSize);
  }

  muzzleFromTank(tank: TankState, boardSize = BOARD_SIZE) {
    return this.muzzlePosition(tank, boardSize);
  }

  impactPoint(muzzle: Vector, horizontalVelocity: Vector, verticalVelocity: number, boardSize = BOARD_SIZE) {
    let position = this.clampProjectilePosition(muzzle, boardSize);
    let height = 0;
    let currentVerticalVelocity = verticalVelocity;

    for (let flightTicks = 1; flightTicks <= 240; flightTicks += 1) {
      const nextPosition = {
        x: position.x + horizontalVelocity.x,
        y: position.y + horizontalVelocity.y,
      };
      const nextHeight = height + currentVerticalVelocity;
      const nextVerticalVelocity = currentVerticalVelocity - PROJECTILE_GRAVITY_UNITS;
      const hitsWall =
        nextPosition.x <= UNITS_PER_SQUARE ||
        nextPosition.y <= UNITS_PER_SQUARE ||
        nextPosition.x >= boardSize * UNITS_PER_SQUARE - UNITS_PER_SQUARE ||
        nextPosition.y >= boardSize * UNITS_PER_SQUARE - UNITS_PER_SQUARE;
      const hitsGround = nextHeight <= 0 && nextVerticalVelocity < 0;

      position = this.clampProjectilePosition(nextPosition, boardSize);
      height = Math.max(0, nextHeight);
      currentVerticalVelocity = nextVerticalVelocity;

      if (hitsWall || hitsGround) {
        return {
          flightTicks,
          flightMs: flightTicks * FRAME_MS,
          position,
          velocity: horizontalVelocity,
          verticalVelocity: currentVerticalVelocity,
          hit: hitsWall ? "wall" as const : "ground" as const,
        };
      }
    }

    return {
      flightTicks: 240,
      flightMs: 240 * FRAME_MS,
      position,
      velocity: horizontalVelocity,
      verticalVelocity: currentVerticalVelocity,
      hit: "timeout" as const,
    };
  }

  formulaText() {
    return [
      `unitsPerSquare=${UNITS_PER_SQUARE}; frame=${FRAME_MS}ms; gravity=${PROJECTILE_GRAVITY_UNITS} vertical-units/frame^2.`,
      "bearing 0=north, 90=east, 180=south, 270=west.",
      "fullPowerRange(elev): 30deg=8000 units, 45deg=6000 units, 60deg=4000 units; linearly interpolate between these anchors.",
      "targetRange = fullPowerRange(elev) * power / 100.",
      "launchSpeed = sqrt(targetRange * gravity / sin(2 * elevRadians)).",
      "horizontalSpeed = cos(elevRadians) * launchSpeed; verticalSpeed = sin(elevRadians) * launchSpeed.",
      "horizontalVelocity = vectorFromBearing(aim, horizontalSpeed); horizontalAcceleration = {x:0,y:0}.",
      "At frame n: position = muzzle + horizontalVelocity*n; height = verticalSpeed*n - 0.5*gravity*n*n; verticalVelocity = verticalSpeed - gravity*n.",
      "Impact occurs when height<=0 while descending, or when top-projection position enters the wall band.",
    ].join("\n");
  }

  private muzzlePosition(tank: TankState, boardSize: number) {
    const tankSpec = normalizeTankSpec(tank.tankSpec);
    const mountOffset = vectorFromBearing(tank.hullDirection, (tankSpec.turretOffset - 0.5) * TANK_LENGTH_UNITS);
    const barrelVector = vectorFromBearing(
      tank.turretDirection,
      (tankSpec.turretSize * TANK_WIDTH_UNITS) / 2 + tankSpec.cannonLength * TANK_LENGTH_UNITS,
    );
    return this.clampProjectilePosition({
      x: tank.position.x + mountOffset.x + barrelVector.x,
      y: tank.position.y + mountOffset.y + barrelVector.y,
    }, boardSize);
  }

  private clampProjectilePosition(position: Vector, boardSize: number) {
    return {
      x: clamp(position.x, UNITS_PER_SQUARE, boardSize * UNITS_PER_SQUARE - UNITS_PER_SQUARE),
      y: clamp(position.y, UNITS_PER_SQUARE, boardSize * UNITS_PER_SQUARE - UNITS_PER_SQUARE),
    };
  }

  private interpolate(value: number, from: number, fromValue: number, to: number, toValue: number) {
    const t = (value - from) / (to - from);
    return fromValue + (toValue - fromValue) * t;
  }
}

export class BattleDamageModel {
  projectileDamage(distanceFromCenter: number, peakDamage = MAX_PROJECTILE_DAMAGE) {
    if (distanceFromCenter > PROJECTILE_HIT_RADIUS_UNITS) {
      return 0;
    }

    const gaussian = Math.exp(-0.5 * (distanceFromCenter / PROJECTILE_DAMAGE_SIGMA) ** 2);
    return clamp(Math.round(peakDamage * gaussian), MIN_PROJECTILE_DAMAGE, peakDamage);
  }

  collisionDamage(impactSpeed: number, maxSpeedUnitsPerTick: number) {
    if (impactSpeed <= 0) {
      return 0;
    }

    return clamp(
      Math.round((impactSpeed / maxSpeedUnitsPerTick) * MAX_COLLISION_DAMAGE * COLLISION_DAMAGE_PER_SPEED),
      1,
      MAX_COLLISION_DAMAGE,
    );
  }

  formulaText(maxSpeedUnitsPerTick: number) {
    return [
      `tankCollisionRadius=${roundForStorage(TANK_COLLISION_RADIUS_UNITS)} units centered on tank position.`,
      `projectileHitRadius=${PROJECTILE_HIT_RADIUS_UNITS} units; sigma=${roundForStorage(PROJECTILE_DAMAGE_SIGMA)}.`,
      `projectileDamage = clamp(round(${MAX_PROJECTILE_DAMAGE} * exp(-0.5 * (distanceFromCenter / ${roundForStorage(PROJECTILE_DAMAGE_SIGMA)})^2)), ${MIN_PROJECTILE_DAMAGE}, ${MAX_PROJECTILE_DAMAGE}).`,
      `collisionImpactSpeed = max(0, -dot(velocity, collisionNormal)).`,
      `collisionDamage = clamp(round((impactSpeed / ${roundForStorage(maxSpeedUnitsPerTick)}) * ${MAX_COLLISION_DAMAGE} * ${COLLISION_DAMAGE_PER_SPEED}), 1, ${MAX_COLLISION_DAMAGE}).`,
    ].join("\n");
  }
}

export class TargetingModel {
  constructor(private projectilePhysics = new ProjectilePhysics()) {}

  indicators(myTank: TankState, opponentTank: TankState, boardSize = BOARD_SIZE) {
    const aimImpact = this.projectilePhysics.impactFromTank(myTank, boardSize);
    const targetPosition = {
      x: opponentTank.position.x + opponentTank.velocity.x * aimImpact.flightTicks,
      y: opponentTank.position.y + opponentTank.velocity.y * aimImpact.flightTicks,
    };
    return {
      aimImpact: this.cleanPoint(aimImpact.position),
      target: this.cleanPoint({
        x: clamp(targetPosition.x, UNITS_PER_SQUARE, boardSize * UNITS_PER_SQUARE - UNITS_PER_SQUARE),
        y: clamp(targetPosition.y, UNITS_PER_SQUARE, boardSize * UNITS_PER_SQUARE - UNITS_PER_SQUARE),
      }),
      flightTicks: aimImpact.flightTicks,
      flightMs: aimImpact.flightMs,
    };
  }

  fireSolutions(myTank: TankState, opponentTank: TankState, boardSize = BOARD_SIZE) {
    return [30, 45, 60]
      .map((elevation) => this.solveFireSolution(myTank, opponentTank, elevation, boardSize))
      .sort((a, b) => a.missDistance - b.missDistance);
  }

  private solveFireSolution(myTank: TankState, opponentTank: TankState, elevation: number, boardSize: number) {
    const muzzle = this.projectilePhysics.muzzleFromTank(myTank, boardSize);
    let predictedTarget = opponentTank.position;
    let power = 50;
    let aim = myTank.turretDirection;
    let impact = this.projectilePhysics.impactFromTank({ ...myTank, launchAngle: elevation, cannonPower: power }, boardSize);

    for (let iteration = 0; iteration < 4; iteration += 1) {
      aim = this.bearingBetween(muzzle, predictedTarget);
      const distance = distanceBetween(muzzle, predictedTarget);
      power = clamp((distance / this.projectilePhysics.fullPowerRange(elevation)) * 100, MIN_FIRE_POWER, MAX_FIRE_POWER);
      impact = this.projectilePhysics.impactFromTank({
        ...myTank,
        turretDirection: aim,
        launchAngle: elevation,
        cannonPower: power,
      }, boardSize);
      predictedTarget = {
        x: clamp(
          opponentTank.position.x + opponentTank.velocity.x * impact.flightTicks,
          UNITS_PER_SQUARE,
          boardSize * UNITS_PER_SQUARE - UNITS_PER_SQUARE,
        ),
        y: clamp(
          opponentTank.position.y + opponentTank.velocity.y * impact.flightTicks,
          UNITS_PER_SQUARE,
          boardSize * UNITS_PER_SQUARE - UNITS_PER_SQUARE,
        ),
      };
    }

    const missDistance = distanceBetween(impact.position, predictedTarget);
    return {
      aim: roundForStorage(aim),
      elevation,
      power: roundForStorage(power),
      predictedTarget: this.cleanPoint(predictedTarget),
      predictedImpact: this.cleanPoint(impact.position),
      missDistance: roundForStorage(missDistance),
      missSquares: roundForStorage(missDistance / UNITS_PER_SQUARE),
      flightTicks: impact.flightTicks,
      flightMs: impact.flightMs,
      command: `aim ${roundForStorage(aim)}; elev ${elevation}; pow ${roundForStorage(power)}; fire`,
    };
  }

  private bearingBetween(from: Vector, to: Vector) {
    return normalizeDegrees((Math.atan2(to.y - from.y, to.x - from.x) * 180) / Math.PI + 90);
  }

  private cleanPoint(point: Vector) {
    return {
      x: roundForStorage(point.x),
      y: roundForStorage(point.y),
      squareX: roundForStorage(point.x / UNITS_PER_SQUARE),
      squareY: roundForStorage(point.y / UNITS_PER_SQUARE),
    };
  }
}
