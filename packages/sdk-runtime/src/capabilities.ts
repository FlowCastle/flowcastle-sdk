import type { RuntimeCapability, RuntimeManifest } from './types';

export interface CapabilityNegotiation { compatible: boolean; missing: RuntimeCapability[]; }
export function negotiateCapabilities(manifest: RuntimeManifest | undefined, available: Iterable<RuntimeCapability>): CapabilityNegotiation {
  const present = new Set(available);
  const missing = (manifest?.requiredCapabilities ?? []).filter((capability) => !present.has(capability));
  return { compatible: missing.length === 0, missing };
}
