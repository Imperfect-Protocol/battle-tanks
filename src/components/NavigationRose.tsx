import type { Tank } from "../libs/Tank";

type NavigationRoseProps = {
  tank: Tank | null | undefined;
};

const majorMarks = Array.from({ length: 36 }, (_, index) => index * 10);
const minorMarks = Array.from({ length: 72 }, (_, index) => index * 5);

export function NavigationRose({ tank }: NavigationRoseProps) {
  const bearing = tank ? normalizeDegrees(angleFromDirection(tank.record.hullDirection)) : 0;
  const aim = tank ? normalizeDegrees(angleFromDirection(tank.record.turretDirection)) : bearing;

  return (
    <section className="navigation-rose" aria-label="Navigation rose">
      <header className="navigation-rose__header">
        <span>HSI</span>
        <strong>{formatDegrees(bearing)}</strong>
      </header>
      <div
        className="navigation-rose__instrument"
        style={
          {
            "--bearing-rotation": `${bearing}deg`,
            "--aim-rotation": `${aim}deg`,
          } as React.CSSProperties
        }
      >
        <div className="navigation-rose__card">
          {minorMarks.map((mark) => (
            <i
              key={mark}
              className={mark % 30 === 0 ? "navigation-rose__tick navigation-rose__tick--major" : "navigation-rose__tick"}
              style={{ "--tick-rotation": `${mark}deg` } as React.CSSProperties}
            />
          ))}
          {majorMarks.map((mark) => (
            <span
              key={mark}
              className="navigation-rose__label"
              style={labelPosition(mark)}
            >
              {labelForMark(mark)}
            </span>
          ))}
        </div>
        <i className="navigation-rose__aim" />
        <i className="navigation-rose__bearing" />
        <div className="navigation-rose__center">
          <span>{formatDegrees(bearing)}</span>
        </div>
      </div>
    </section>
  );
}

function labelForMark(mark: number) {
  return String(mark / 10).padStart(2, "0");
}

function labelPosition(mark: number) {
  const radians = (mark * Math.PI) / 180;
  const radius = 55;

  return {
    left: `${50 + Math.sin(radians) * radius}%`,
    top: `${50 - Math.cos(radians) * radius}%`,
  } as React.CSSProperties;
}

function formatDegrees(degrees: number) {
  return `${Math.round(normalizeDegrees(degrees)).toString().padStart(3, "0")} deg`;
}

function normalizeDegrees(degrees: number) {
  return ((degrees % 360) + 360) % 360;
}

function angleFromDirection(direction: Tank["record"]["hullDirection"]) {
  if (typeof direction === "number") {
    return direction;
  }

  return {
    north: 0,
    east: 90,
    south: 180,
    west: 270,
  }[direction];
}
