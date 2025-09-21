// Single compile-time dev flag.
export const DEBUG_LOGGING = true;
export const dlog = (...a: any[]) => {
  if (DEBUG_LOGGING) console.log("[autosave-control]", ...a);
};