/**
 * MediaGenerationSkeleton — the compact status card shown while image / video
 * results stream in. Intentionally small and quiet: a single rounded row with
 * the media icon, a live label and a thin indeterminate progress line, so the
 * chat never jumps around when the finished media replaces it.
 *
 * Motion is skipped on low-end devices and when the user prefers reduced motion.
 */

import { Image as ImageIcon, Film } from "lucide-react";
import { isLowEndDevice } from "@/lib/deviceCapability";

type Kind = "images" | "video";

interface MediaGenerationSkeletonProps {
  kind: Kind;
  /** Kept for call-site compatibility; the card is always a single row. */
  count?: number;
  className?: string;
}

const KIND_META: Record<Kind, { icon: typeof ImageIcon; label: string }> = {
  images: { icon: ImageIcon, label: "Creating image" },
  video: { icon: Film, label: "Creating video" },
};

const prefersReducedMotion = () =>
  typeof window !== "undefined" &&
  typeof window.matchMedia === "function" &&
  window.matchMedia("(prefers-reduced-motion: reduce)").matches;

export function MediaGenerationSkeleton({
  kind,
  className = "",
}: MediaGenerationSkeletonProps) {
  const meta = KIND_META[kind];
  if (!meta) return null;

  const Icon = meta.icon;
  const still = isLowEndDevice() || prefersReducedMotion();

  return (
    <div
      className={`mb-3 w-full max-w-[20rem] ${className}`}
      role="status"
      aria-live="polite"
      aria-label={meta.label}
    >
      <div className="flex items-center gap-2.5 rounded-2xl border border-foreground/10 bg-foreground/[0.03] px-3 py-2.5">
        <span className="grid h-7 w-7 shrink-0 place-items-center rounded-full border border-foreground/10 bg-foreground/[0.04]">
          <Icon
            className={`h-3.5 w-3.5 text-foreground/70 ${still ? "" : "animate-pulse"}`}
          />
        </span>
        <div className="min-w-0 flex-1">
          <p className="truncate text-[13px] font-medium text-foreground/80">
            {meta.label}
          </p>
          <div className="mt-1.5 h-[3px] w-full overflow-hidden rounded-full bg-foreground/10">
            <div
              aria-hidden
              className={
                still
                  ? "h-full w-1/3 rounded-full bg-foreground/35"
                  : "h-full w-1/3 rounded-full bg-foreground/35 animate-[media-gen-sweep_1.5s_ease-in-out_infinite]"
              }
            />
          </div>
        </div>
      </div>
      {!still && (
        <style>{`
          @keyframes media-gen-sweep {
            0% { transform: translateX(-100%); }
            100% { transform: translateX(300%); }
          }
        `}</style>
      )}
    </div>
  );
}

export default MediaGenerationSkeleton;
