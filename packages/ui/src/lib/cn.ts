import { clsx, type ClassValue } from 'clsx'
import { twMerge } from 'tailwind-merge'

/** Conditional classes with later Tailwind utilities winning over earlier ones,
 * so a component's own class can override the one it was handed. */
export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs))
}
