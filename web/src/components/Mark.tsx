import { STACK_MARKS } from "@/lib/stack-logos";
import { markKey } from "@/lib/catalog";

export function Mark({ id, size = 36 }: { id: string; size?: number }) {
  const key = markKey(id);
  const mark = (STACK_MARKS as Record<string, { color: string; d: string }>)[key];
  const color = mark?.color || "#64748b";
  return (
    <span
      className="inline-grid place-items-center rounded-xl shrink-0"
      style={{
        width: size,
        height: size,
        color,
        background: `color-mix(in srgb, ${color} 14%, white)`,
        boxShadow: `inset 0 0 0 1px color-mix(in srgb, ${color} 28%, transparent)`,
      }}
    >
      <svg viewBox="0 0 24 24" width={size * 0.5} height={size * 0.5} aria-hidden>
        <path fill="currentColor" d={mark?.d || "M4 4h16v16H4z"} />
      </svg>
    </span>
  );
}
