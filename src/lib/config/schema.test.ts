import { describe, expect, it } from "vitest";
import {
  isAppConfigError,
  parseAppConfig,
  serializeAppConfig,
  type AppConfigIssueCode,
  type RawAppConfig,
} from "./schema";

const settingsRows = [
  ["schemaVersion", "1"],
  ["setupState", "ready"],
  ["month", "2026-07"],
  ["ownerEmail", "manager@blended-asia.com"],
  ["templateVersion", "1"],
];

const statusHeader = ["code", "labelEn", "sheetValue"];
const memberHeader = [
  "displayName",
  "email",
  "sheetId",
  "sheetTitle",
  "protectionId",
  "permissionId",
  "setupStatus",
];

function buildRaw(overrides: Partial<RawAppConfig> = {}): RawAppConfig {
  return {
    settings: settingsRows,
    statuses: [statusHeader, ["office", "Office", "出社"]],
    members: [
      memberHeader,
      ["Linh", "employee@blended-asia.com", "123", "Linh", "456", "789", "ready"],
    ],
    ...overrides,
  };
}

function expectRejection(raw: RawAppConfig, code: AppConfigIssueCode): void {
  try {
    parseAppConfig(raw);
  } catch (error) {
    if (!isAppConfigError(error)) throw error;
    expect(error.code).toBe(code);
    expect(error.message.length).toBeGreaterThan(0);
    return;
  }

  throw new Error(`expected parseAppConfig to reject with "${code}"`);
}

describe("parseAppConfig", () => {
  it("parses the version-1 schema from the fixed config ranges", () => {
    const parsed = parseAppConfig({
      settings: [
        ["schemaVersion", "1"],
        ["setupState", "ready"],
        ["month", "2026-07"],
        ["ownerEmail", "Manager@Blended-Asia.com"],
        ["templateVersion", "1"],
      ],
      statuses: [
        ["code", "labelEn", "sheetValue"],
        ["office", "Office", "出社"],
        ["absent", "Absent", "欠勤"],
      ],
      members: [
        ["displayName", "email", "sheetId", "sheetTitle", "protectionId", "permissionId", "setupStatus"],
        ["Linh", "Employee@Blended-Asia.com", "123", "Linh", "456", "789", "ready"],
      ],
    });

    expect(parsed.ownerEmail).toBe("manager@blended-asia.com");
    expect(parsed.members[0].email).toBe("employee@blended-asia.com");
    expect(parsed.members[0].sheetId).toBe("123");

    expect(parsed.schemaVersion).toBe(1);
    expect(parsed.setupState).toBe("ready");
    expect(parsed.month).toBe("2026-07");
    expect(parsed.templateVersion).toBe(1);
    expect(parsed.statuses).toEqual([
      { code: "office", labelEn: "Office", sheetValue: "出社" },
      { code: "absent", labelEn: "Absent", sheetValue: "欠勤" },
    ]);
    expect(parsed.members).toEqual([
      {
        displayName: "Linh",
        email: "employee@blended-asia.com",
        sheetId: "123",
        sheetTitle: "Linh",
        protectionId: "456",
        permissionId: "789",
        setupStatus: "ready",
      },
    ]);
  });

  it("keeps numeric Google resource identifiers as strings", () => {
    const parsed = parseAppConfig(buildRaw());
    const member = parsed.members[0];

    expect(typeof member.sheetId).toBe("string");
    expect(typeof member.protectionId).toBe("string");
    expect(typeof member.permissionId).toBe("string");
    expect(member.protectionId).toBe("456");
    expect(member.permissionId).toBe("789");
  });

  it("normalizes emails to trimmed lowercase before storage", () => {
    const parsed = parseAppConfig(buildRaw({
      settings: [
        ["schemaVersion", "1"],
        ["setupState", "ready"],
        ["month", "2026-07"],
        ["ownerEmail", "  Manager@Blended-Asia.COM  "],
        ["templateVersion", "1"],
      ],
      members: [
        memberHeader,
        ["  Linh  ", " Employee@BLENDED-asia.com ", "123", " Linh ", "456", "789", "ready"],
      ],
    }));

    expect(parsed.ownerEmail).toBe("manager@blended-asia.com");
    expect(parsed.members[0].email).toBe("employee@blended-asia.com");
    expect(parsed.members[0].displayName).toBe("Linh");
    expect(parsed.members[0].sheetTitle).toBe("Linh");
  });

  it("treats absent optional member identifiers as null", () => {
    const parsed = parseAppConfig(buildRaw({
      members: [
        memberHeader,
        ["Linh", "employee@blended-asia.com", "", "", "", "", "invite-failed"],
      ],
    }));

    expect(parsed.members[0]).toEqual({
      displayName: "Linh",
      email: "employee@blended-asia.com",
      sheetId: null,
      sheetTitle: null,
      protectionId: null,
      permissionId: null,
      setupStatus: "invite-failed",
    });
  });

  describe("blank row termination", () => {
    it("stops parsing the status table at the first fully blank row", () => {
      const parsed = parseAppConfig(buildRaw({
        statuses: [
          statusHeader,
          ["office", "Office", "出社"],
          ["", "", ""],
          ["absent", "Absent", "欠勤"],
        ],
      }));

      expect(parsed.statuses).toEqual([{ code: "office", labelEn: "Office", sheetValue: "出社" }]);
    });

    it("stops parsing the member table at the first fully blank row", () => {
      const parsed = parseAppConfig(buildRaw({
        members: [
          memberHeader,
          ["Linh", "employee-a@blended-asia.com", "123", "Linh", "456", "789", "ready"],
          ["", "", "", "", "", "", ""],
          ["Mai", "employee-b@blended-asia.com", "321", "Mai", "654", "987", "ready"],
        ],
      }));

      expect(parsed.members).toHaveLength(1);
      expect(parsed.members[0].email).toBe("employee-a@blended-asia.com");
    });

    it("treats a whitespace-only row as blank and carries no member meaning", () => {
      const parsed = parseAppConfig(buildRaw({
        members: [memberHeader, ["   ", "", " ", "", "", "", ""]],
      }));

      expect(parsed.members).toEqual([]);
    });

    it("accepts empty status and member tables that contain only a header", () => {
      const parsed = parseAppConfig(buildRaw({
        statuses: [statusHeader],
        members: [memberHeader],
      }));

      expect(parsed.statuses).toEqual([]);
      expect(parsed.members).toEqual([]);
    });
  });

  describe("rejections", () => {
    it("rejects an unknown schema version instead of reinterpreting the columns", () => {
      expectRejection(
        buildRaw({
          settings: [
            ["schemaVersion", "2"],
            ["setupState", "ready"],
            ["month", "2026-07"],
            ["ownerEmail", "manager@blended-asia.com"],
            ["templateVersion", "1"],
          ],
        }),
        "unsupported-schema-version",
      );
    });

    it("rejects a non-numeric schema version", () => {
      expectRejection(
        buildRaw({
          settings: [
            ["schemaVersion", "one"],
            ["setupState", "ready"],
            ["month", "2026-07"],
            ["ownerEmail", "manager@blended-asia.com"],
            ["templateVersion", "1"],
          ],
        }),
        "unsupported-schema-version",
      );
    });

    it("rejects an invalid setup state", () => {
      expectRejection(
        buildRaw({
          settings: [
            ["schemaVersion", "1"],
            ["setupState", "done"],
            ["month", "2026-07"],
            ["ownerEmail", "manager@blended-asia.com"],
            ["templateVersion", "1"],
          ],
        }),
        "invalid-setting-value",
      );
    });

    it("rejects an invalid month", () => {
      expectRejection(
        buildRaw({
          settings: [
            ["schemaVersion", "1"],
            ["setupState", "ready"],
            ["month", "2026-13"],
            ["ownerEmail", "manager@blended-asia.com"],
            ["templateVersion", "1"],
          ],
        }),
        "invalid-setting-value",
      );
    });

    it("rejects an invalid owner email", () => {
      expectRejection(
        buildRaw({
          settings: [
            ["schemaVersion", "1"],
            ["setupState", "ready"],
            ["month", "2026-07"],
            ["ownerEmail", "manager"],
            ["templateVersion", "1"],
          ],
        }),
        "invalid-setting-value",
      );
    });

    it("rejects a missing settings key", () => {
      expectRejection(
        buildRaw({
          settings: [
            ["schemaVersion", "1"],
            ["setupState", "ready"],
            ["month", "2026-07"],
            ["ownerEmail", "manager@blended-asia.com"],
          ],
        }),
        "missing-setting",
      );
    });

    it("rejects an unknown settings key", () => {
      expectRejection(
        buildRaw({
          settings: [
            ["schemaVersion", "1"],
            ["setupState", "ready"],
            ["month", "2026-07"],
            ["ownerEmail", "manager@blended-asia.com"],
            ["templateRevision", "1"],
          ],
        }),
        "unknown-setting",
      );
    });

    it("rejects a duplicated settings key", () => {
      expectRejection(
        buildRaw({
          settings: [
            ["schemaVersion", "1"],
            ["setupState", "ready"],
            ["month", "2026-07"],
            ["ownerEmail", "manager@blended-asia.com"],
            ["month", "2026-08"],
          ],
        }),
        "duplicate-setting",
      );
    });

    it("rejects a missing status header row", () => {
      expectRejection(buildRaw({ statuses: [] }), "missing-header");
    });

    it("rejects an incorrect status header row", () => {
      expectRejection(
        buildRaw({ statuses: [["code", "label", "sheetValue"], ["office", "Office", "出社"]] }),
        "invalid-header",
      );
    });

    it("rejects a missing member header row", () => {
      expectRejection(buildRaw({ members: [] }), "missing-header");
    });

    it("rejects an incorrect member header row", () => {
      expectRejection(
        buildRaw({
          members: [
            ["displayName", "email", "sheetId", "sheetTitle", "protectionId", "permissionId"],
            ["Linh", "employee@blended-asia.com", "123", "Linh", "456", "789", "ready"],
          ],
        }),
        "invalid-header",
      );
    });

    it("rejects a member row with an invalid email", () => {
      expectRejection(
        buildRaw({
          members: [memberHeader, ["Linh", "employee", "123", "Linh", "456", "789", "ready"]],
        }),
        "invalid-member-row",
      );
    });

    it("rejects a member row with a missing display name", () => {
      expectRejection(
        buildRaw({
          members: [memberHeader, ["", "employee@blended-asia.com", "123", "Linh", "456", "789", "ready"]],
        }),
        "invalid-member-row",
      );
    });

    it("rejects a member row with a missing setup status", () => {
      expectRejection(
        buildRaw({
          members: [memberHeader, ["Linh", "employee@blended-asia.com", "123", "Linh", "456", "789", ""]],
        }),
        "invalid-member-row",
      );
    });

    it("rejects a non-numeric sheet id", () => {
      expectRejection(
        buildRaw({
          members: [memberHeader, ["Linh", "employee@blended-asia.com", "sheet-1", "Linh", "456", "789", "ready"]],
        }),
        "invalid-member-row",
      );
    });

    it("rejects duplicate normalized member emails", () => {
      expectRejection(
        buildRaw({
          members: [
            memberHeader,
            ["Linh", "Employee@Blended-Asia.com", "123", "Linh", "456", "789", "ready"],
            ["Mai", "employee@blended-asia.com", "321", "Mai", "654", "987", "ready"],
          ],
        }),
        "duplicate-member-email",
      );
    });

    it("rejects duplicate member sheet ids", () => {
      expectRejection(
        buildRaw({
          members: [
            memberHeader,
            ["Linh", "employee-a@blended-asia.com", "123", "Linh", "456", "789", "ready"],
            ["Mai", "employee-b@blended-asia.com", "123", "Mai", "654", "987", "ready"],
          ],
        }),
        "duplicate-member-sheet-id",
      );
    });

    it("rejects duplicate status codes", () => {
      expectRejection(
        buildRaw({
          statuses: [
            statusHeader,
            ["office", "Office", "出社"],
            ["office", "In office", "出勤"],
          ],
        }),
        "duplicate-status-code",
      );
    });

    it("rejects a status row with a blank sheet value", () => {
      expectRejection(
        buildRaw({ statuses: [statusHeader, ["office", "Office", ""]] }),
        "invalid-status-row",
      );
    });

    it("reports which rule failed through a stable issue code", () => {
      expect.assertions(3);

      try {
        parseAppConfig(buildRaw({ statuses: [] }));
      } catch (error) {
        expect(isAppConfigError(error)).toBe(true);
        if (!isAppConfigError(error)) return;
        expect(error.code).toBe("missing-header");
        expect(error.table).toBe("statuses");
      }
    });
  });
});

describe("serializeAppConfig", () => {
  it("writes the fixed-coordinate rows a config sheet expects", () => {
    const parsed = parseAppConfig(buildRaw({
      statuses: [statusHeader, ["office", "Office", "出社"], ["absent", "Absent", "欠勤"]],
    }));

    expect(serializeAppConfig(parsed)).toEqual({
      settings: [
        ["schemaVersion", "1"],
        ["setupState", "ready"],
        ["month", "2026-07"],
        ["ownerEmail", "manager@blended-asia.com"],
        ["templateVersion", "1"],
      ],
      statuses: [
        ["code", "labelEn", "sheetValue"],
        ["office", "Office", "出社"],
        ["absent", "Absent", "欠勤"],
      ],
      members: [
        ["displayName", "email", "sheetId", "sheetTitle", "protectionId", "permissionId", "setupStatus"],
        ["Linh", "employee@blended-asia.com", "123", "Linh", "456", "789", "ready"],
      ],
    });
  });

  it("writes absent optional identifiers as empty cells", () => {
    const parsed = parseAppConfig(buildRaw({
      members: [memberHeader, ["Linh", "employee@blended-asia.com", "", "", "", "", "invite-failed"]],
    }));

    expect(serializeAppConfig(parsed).members[1]).toEqual([
      "Linh",
      "employee@blended-asia.com",
      "",
      "",
      "",
      "",
      "invite-failed",
    ]);
  });

  it("round-trips a parsed config without loss", () => {
    const raw = buildRaw({
      statuses: [statusHeader, ["office", "Office", "出社"], ["absent", "Absent", "欠勤"]],
      members: [
        memberHeader,
        ["Linh", "employee-a@blended-asia.com", "123", "Linh", "456", "789", "ready"],
        ["Mai", "employee-b@blended-asia.com", "321", "Mai", "", "", "invite-failed"],
      ],
    });
    const parsed = parseAppConfig(raw);

    expect(parseAppConfig(serializeAppConfig(parsed))).toEqual(parsed);
  });
});
