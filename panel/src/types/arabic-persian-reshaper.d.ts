// Minimal ambient typings for `arabic-persian-reshaper` (no upstream types).
// Only the surface we actually call is declared; both shapers expose the
// same `convertArabic(input)` method that returns a string composed of
// Arabic presentation forms (U+FB50..U+FEFC) in logical order.
declare module 'arabic-persian-reshaper' {
  interface Shaper { convertArabic(text: string): string }
  export const ArabicShaper: Shaper;
  export const PersianShaper: Shaper;
  const _default: { ArabicShaper: Shaper; PersianShaper: Shaper };
  export default _default;
}
