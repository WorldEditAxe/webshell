// Animation durations, or none when the system asks for reduced motion.
const reduced = typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;
export const motion = (ms: number): number => (reduced ? 0 : ms);
