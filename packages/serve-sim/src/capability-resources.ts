import type { CapabilityContext, CapabilityDefinition, PreparedCapability } from "./capabilities";
import type { Capability } from "./launch-state";

export interface CapabilityPreparation {
  capability: Capability;
  resources: PreparedCapability;
}

export async function prepareCapability(
  definition: CapabilityDefinition,
  context: CapabilityContext,
): Promise<CapabilityPreparation | null> {
  const resources = await definition.setEnabled(context);
  if (!resources) return null;
  return {
    capability: {
      name: definition.name,
      dylib: resources.dylib,
      env: resources.env,
      scope: definition.scope,
      loadDelayMs: definition.loadDelayMs,
      loadPhase: definition.loadPhase,
    },
    resources,
  };
}

export async function rollbackPreparations(
  udid: string,
  preparations: CapabilityPreparation[],
  error: unknown,
): Promise<void> {
  const failures: unknown[] = [error];
  for (const { resources } of [...preparations].reverse()) {
    try {
      await resources.rollback?.(error);
    } catch (cleanupError) {
      failures.push(cleanupError);
    }
  }
  if (failures.length > 1) {
    throw new AggregateError(
      failures,
      `Capability preparation cleanup failed on ${udid}. Retry cleanup before enabling it again.`,
    );
  }
}
