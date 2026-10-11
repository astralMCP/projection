/**
 * The subset of the WebAssembly JS API the sandbox uses (session.ts,
 * `boundedWasmMemory`). TypeScript ships these types only in its DOM lib,
 * which this Node library deliberately does not load; Node provides the
 * global at runtime. Ambient and internal: it informs this package's
 * typecheck and is not part of the emitted declarations.
 */
declare namespace WebAssembly {
  interface MemoryDescriptor {
    /** Initial size, in 64 KiB pages. */
    initial: number;
    /** Largest size the memory may grow to, in 64 KiB pages. */
    maximum?: number;
  }
  interface Memory {
    readonly buffer: ArrayBuffer;
    grow(delta: number): number;
  }
  const Memory: {
    prototype: Memory;
    new (descriptor: MemoryDescriptor): Memory;
  };
  /** A compiled, not yet instantiated, WebAssembly module. */
  interface Module {
    readonly [Symbol.toStringTag]: string;
  }
  function compile(bytes: ArrayBuffer | ArrayBufferView): Promise<Module>;
}
