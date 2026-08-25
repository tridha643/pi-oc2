import { describe, expect, it } from "vitest";
import { serializePiocLock, serializeStableJson } from "./deterministic-artifacts.js";

describe("deterministic artifact serialization", () => {
  it("sorts nested keys and emits exactly one final newline", () => {
    expect(serializeStableJson({ z: 1, a: { y: 2, b: 3 } })).toBe('{\n  "a": {\n    "b": 3,\n    "y": 2\n  },\n  "z": 1\n}\n');
    expect(
      serializePiocLock({ schemaVersion: 1, generatorVersion: "0.1.0", sourceHash: "abc", targetProfile: "pi-0.84.3" }),
    ).toBe(
      '{\n  "generatorVersion": "0.1.0",\n  "schemaVersion": 1,\n  "sourceHash": "abc",\n  "targetProfile": "pi-0.84.3"\n}\n',
    );
  });
});
