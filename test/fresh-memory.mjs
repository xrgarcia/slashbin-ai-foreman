// Test helper: the same runtime (same stores) with a fresh PhaseMemory, for a test that
// simulates a pass boundary without losing what the stores hold. The stores are shared
// through the prototype; only `memory` is replaced.
import { PhaseMemory } from "../dist/phase-memory.js";

export const withFreshMemory = (rt) => Object.create(rt, { memory: { value: new PhaseMemory() } });
