// The browser script and the Worker share src/ui, so the type check loads the DOM types next to the Worker types.
// Where both declare a global, the DOM one wins, so this puts back the Worker extension that our Worker code uses.
interface SubtleCrypto {
  timingSafeEqual(a: ArrayBuffer | ArrayBufferView, b: ArrayBuffer | ArrayBufferView): boolean;
}
