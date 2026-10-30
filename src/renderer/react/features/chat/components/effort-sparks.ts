// Sparks for the effort bar: short luminous streaks drifting along the filled part, more and faster the harder the
// model is set to think. Pure state and stepping here; EffortBar owns the canvas and the animation frame.

export interface Spark { x: number; y: number; speed: number; length: number; alpha: number; size: number }

const clamp01 = (value: number) => Math.min(1, Math.max(0, value));

/** How many sparks a level shows: a few at the lowest, a dense stream at the highest. */
export function sparkCount(level: number): number {
  return Math.round(4 + 26 * clamp01(level));
}

/** Pixels per second for a spark of speed 1: slow drift at the lowest level, a rush at the highest. */
export function sparkPace(level: number): number {
  return 24 + 156 * clamp01(level);
}

/** A new spark; `spread` places it anywhere along the bar (first frame), otherwise just off the left edge. */
export function makeSpark(width: number, height: number, random: () => number = Math.random, spread = false): Spark {
  const length = 6 + random() * 22;
  return {
    x: spread ? random() * width : -random() * width * 0.25,
    y: height * (0.22 + random() * 0.56),
    speed: 0.45 + random() * 0.95,
    length,
    alpha: 0.35 + random() * 0.6,
    size: 0.6 + random() * 1.1,
  };
}

/** Moves every spark, recycles the ones that left on the right, and grows or trims the stream to the level. */
export function stepSparks(sparks: Spark[], seconds: number, width: number, height: number, level: number,
  boost = 1, random: () => number = Math.random): Spark[] {
  const pace = sparkPace(level) * boost;
  const moved = sparks.map((spark) => {
    const x = spark.x + spark.speed * pace * seconds;
    return x - spark.length > width ? makeSpark(width, height, random) : { ...spark, x };
  });
  const wanted = sparkCount(level);
  while (moved.length < wanted) moved.push(makeSpark(width, height, random));
  return moved.length > wanted ? moved.slice(0, wanted) : moved;
}
