import type { Capability } from "./launch-manager";

/**
 * Dlopened inside an app container, so it may link UIKit and Foundation. Its
 * constructor runs on the trampoline's load thread, not on main, and more than
 * one process can carry it, so key anything it writes by process or bundle.
 */
export interface CapabilityDefinition {
  name: string;
  defaultEnabled: boolean;
  /** Return null to decline, so a default-on capability degrades to off. */
  resolve(udid: string, bundleId: string | null): Promise<Capability | null>;
}

const registry = new Map<string, CapabilityDefinition>();

export function registerCapability(definition: CapabilityDefinition): void {
  registry.set(definition.name, definition);
}

export function registeredCapabilities(): CapabilityDefinition[] {
  return [...registry.values()].sort((a, b) => a.name.localeCompare(b.name));
}

export interface CapabilityOverrides {
  enable?: string[];
  disable?: string[];
}

export class UnknownCapabilityError extends Error {
  constructor(name: string, known: string[]) {
    super(
      `Unknown capability '${name}'. ` +
        (known.length > 0 ? `Available: ${known.join(", ")}.` : "None are registered."),
    );
  }
}

export function capabilitiesToApply({
  enable = [],
  disable = [],
}: CapabilityOverrides): CapabilityDefinition[] {
  const known = registeredCapabilities();
  const names = known.map((definition) => definition.name);
  for (const name of [...enable, ...disable]) {
    if (!registry.has(name)) throw new UnknownCapabilityError(name, names);
  }
  return known.filter(
    (definition) =>
      !disable.includes(definition.name) &&
      (definition.defaultEnabled || enable.includes(definition.name)),
  );
}
