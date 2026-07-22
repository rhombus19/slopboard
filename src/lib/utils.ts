import { clsx, type ClassValue } from "clsx";
import type { CSSProperties } from "react";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

function hashTag(tag: string): number {
  const normalized = tag.normalize("NFKC").trim().toLowerCase();
  let hash = 2166136261;

  for (let index = 0; index < normalized.length; index += 1) {
    hash ^= normalized.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }

  return hash >>> 0;
}

export function tagColorStyle(tag: string): CSSProperties {
  const hash = hashTag(tag);
  const hue = hash % 360;
  const saturation = 52 + ((hash >>> 8) % 17);

  return {
    backgroundColor: `hsl(${hue} ${saturation}% 94%)`,
    borderColor: `hsl(${hue} ${Math.max(42, saturation - 8)}% 80%)`,
    color: `hsl(${hue} ${Math.min(72, saturation + 4)}% 27%)`,
  };
}
