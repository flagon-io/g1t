import { encode } from "uqr";

/**
 * A QR code drawn as one SVG path, dark on white in either theme so any
 * phone's camera reads it. `label` names what it holds for screen readers.
 */
export function QrCode({ value, label, size = 184 }: { value: string; label: string; size?: number }) {
  const { data, size: modules } = encode(value, { ecc: "M", border: 2 });
  let path = "";
  data.forEach((row, y) => {
    row.forEach((dark, x) => {
      if (dark) path += `M${x} ${y}h1v1h-1z`;
    });
  });
  return (
    <svg
      role="img"
      aria-label={label}
      viewBox={`0 0 ${modules} ${modules}`}
      width={size}
      height={size}
      shapeRendering="crispEdges"
      className="rounded-md"
    >
      <rect width={modules} height={modules} fill="#ffffff" />
      <path d={path} fill="#000000" />
    </svg>
  );
}
