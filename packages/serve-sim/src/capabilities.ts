/**
 * What to load. Dlopened inside an app container, so it may link UIKit and
 * Foundation, and more than one process can carry it, so key anything it writes
 * by process or bundle.
 */
export interface PreparedCapability {
  dylib: string;
  env?: Record<string, string>;
}

/**
 * Which apps load the dylib. `allApps` adds Apple's own, such as Safari.
 * Neither scope needs the app to exist yet, so both can be armed before
 * anything is installed.
 */
export type CapabilityScope = "userApps" | "allApps";

export interface CapabilityContext {
  udid: string;
  /** The app to relaunch and grant permissions to, when one was named. */
  bundleId: string | null;
  /** Whatever the command that toggled it passed through, such as a source. */
  options: Record<string, string>;
  enabled: boolean;
}

export interface CapabilityDefinition {
  name: string;
  defaultEnabled: boolean;
  /** Fixed by the capability, not the caller. */
  scope: CapabilityScope;
  /**
   * Milliseconds to wait before loading it into a starting app. A capability
   * that links UIKit needs the app past its own startup; one that links only
   * libSystem should leave this unset and load straight away.
   */
  loadDelayMs?: number;
  /**
   * Bring the capability to `ctx.enabled`, including any host-side work such as
   * starting or stopping a helper. Returns what to load when turning it on, or
   * null to decline, which leaves a default-on capability off.
   */
  setEnabled(ctx: CapabilityContext): Promise<PreparedCapability | null>;
}

const registry = new Map<string, CapabilityDefinition>();

export function registerCapability(definition: CapabilityDefinition): void {
  registry.set(definition.name, definition);
}

/** Tests share one module instance, so each file has to start from a known set. */
export function clearRegisteredCapabilities(): void {
  registry.clear();
}

export function capabilityDefinition(name: string): CapabilityDefinition {
  const definition = registry.get(name);
  if (!definition) {
    throw new UnknownCapabilityError(
      name,
      registeredCapabilities().map((known) => known.name),
    );
  }
  return definition;
}

export function assertKnownCapabilities(names: string[]): void {
  const known = registeredCapabilities().map((definition) => definition.name);
  for (const name of names) {
    if (!registry.has(name)) throw new UnknownCapabilityError(name, known);
  }
}

export function hasDefaultCapabilities(): boolean {
  return registeredCapabilities().some((definition) => definition.defaultEnabled);
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
