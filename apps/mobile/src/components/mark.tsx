import Svg, { Rect } from "react-native-svg";

import { useColors } from "@/theme";

/**
 * The g1t mark, as packages/theme/mark.svg draws it: pixels on an 80 by
 * 80 grid, in the accent.
 */
const PIXELS: [number, number][] = [
  [36, 6],
  [26, 16],
  [36, 16],
  [16, 26],
  [36, 26],
  [36, 36],
  [36, 46],
  [36, 56],
  [16, 66],
  [26, 66],
  [36, 66],
  [46, 66],
  [56, 66],
];

export function G1tMark({ size = 32 }: { size?: number }) {
  const colors = useColors();
  return (
    <Svg width={size} height={size} viewBox="0 0 80 80" accessibilityLabel="g1t">
      {PIXELS.map(([x, y]) => (
        <Rect key={`${x}-${y}`} x={x} y={y} width={8} height={8} fill={colors.accent} />
      ))}
    </Svg>
  );
}
