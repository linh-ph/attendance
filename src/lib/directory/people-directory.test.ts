import { describe, expect, it, vi } from "vitest";
import type { AttendanceFileSummary, DriveGateway, DrivePerson } from "@/lib/google/types";
import { GoogleApiError } from "@/lib/google/errors";
import { createPeopleDirectory } from "./people-directory";

const ACTOR = "linh.np@blended-asia.com";

function summary(id: string, name: string): AttendanceFileSummary {
  return {
    id,
    name,
    ownedByMe: false,
    sharedWithMe: true,
    ownerEmail: null,
    appProperties: {},
    modifiedTime: null,
  };
}

function person(email: string, displayName: string | null = null): DrivePerson {
  return { email, role: "writer", displayName };
}

function unsupported(): never {
  throw new Error("not used by the directory");
}

function fakeDrive(
  files: AttendanceFileSummary[],
  peopleByFile: Record<string, DrivePerson[] | Error>,
): DriveGateway & { listPeopleCalls: string[] } {
  const listPeopleCalls: string[] = [];

  return {
    listPeopleCalls,
    listEmployeeCandidates: async () => files,
    listPeople: async (fileId: string) => {
      listPeopleCalls.push(fileId);
      const answer = peopleByFile[fileId] ?? [];
      if (answer instanceof Error) throw answer;
      return answer;
    },
    validateManagerFolder: unsupported,
    listManagerFiles: unsupported,
    getFileAccess: unsupported,
    createSpreadsheetFile: unsupported,
    convertXlsx: unsupported,
    createWriterPermission: unsupported,
    updateAppProperties: unsupported,
  };
}

describe("createPeopleDirectory", () => {
  it("gathers everyone who can reach the attendance files this account sees", async () => {
    const drive = fakeDrive(
      [summary("file-1", "202608勤怠管理表"), summary("file-2", "202607勤怠管理表")],
      {
        "file-1": [person("quynh.kt@blended-asia.com", "TRAN QUYNH"), person(ACTOR)],
        "file-2": [person("han.tg@blended-asia.com")],
      },
    );

    await expect(createPeopleDirectory(drive).load(ACTOR)).resolves.toEqual([
      { email: "han.tg@blended-asia.com", displayName: null, fileCount: 1 },
      { email: "quynh.kt@blended-asia.com", displayName: "TRAN QUYNH", fileCount: 1 },
    ]);

    expect(drive.listPeopleCalls).toEqual(["file-1", "file-2"]);
  });

  it("leaves the signed-in account out — nobody adds themselves to a roster", async () => {
    const drive = fakeDrive([summary("file-1", "202608勤怠管理表")], {
      "file-1": [person(ACTOR, "NGUYEN PHAN LINH")],
    });

    await expect(createPeopleDirectory(drive).load(ACTOR)).resolves.toEqual([]);
  });

  it("counts one person once, across every file that grants them access", async () => {
    const drive = fakeDrive(
      [summary("file-1", "a勤怠管理表"), summary("file-2", "b勤怠管理表"), summary("file-3", "c勤怠管理表")],
      {
        "file-1": [person("han.tg@blended-asia.com")],
        "file-2": [person("han.tg@blended-asia.com"), person("quynh.kt@blended-asia.com")],
        "file-3": [person("han.tg@blended-asia.com")],
      },
    );

    // Most widely shared first: the people on every file are the colleagues.
    await expect(createPeopleDirectory(drive).load(ACTOR)).resolves.toEqual([
      { email: "han.tg@blended-asia.com", displayName: null, fileCount: 3 },
      { email: "quynh.kt@blended-asia.com", displayName: null, fileCount: 1 },
    ]);
  });

  it("keeps the first name Drive gives, and fills in a name a later file supplies", async () => {
    const drive = fakeDrive([summary("file-1", "a勤怠管理表"), summary("file-2", "b勤怠管理表")], {
      "file-1": [person("han.tg@blended-asia.com")],
      "file-2": [person("han.tg@blended-asia.com", "THAI GIA HAN")],
    });

    await expect(createPeopleDirectory(drive).load(ACTOR)).resolves.toEqual([
      { email: "han.tg@blended-asia.com", displayName: "THAI GIA HAN", fileCount: 2 },
    ]);
  });

  /**
   * A file may be openable while its sharing list is not, and a shared drive can
   * refuse one file out of eight. One refusal must not empty the directory.
   */
  it("skips a file whose sharing cannot be read, and keeps the rest", async () => {
    const drive = fakeDrive([summary("file-1", "a勤怠管理表"), summary("file-2", "b勤怠管理表")], {
      "file-1": new GoogleApiError("Google request failed: permissions.list."),
      "file-2": [person("han.tg@blended-asia.com")],
    });

    await expect(createPeopleDirectory(drive).load(ACTOR)).resolves.toEqual([
      { email: "han.tg@blended-asia.com", displayName: null, fileCount: 1 },
    ]);
  });

  it("answers with an empty directory when no file is reachable", async () => {
    await expect(createPeopleDirectory(fakeDrive([], {})).load(ACTOR)).resolves.toEqual([]);
  });

  it("reads the files once, however many people they name", async () => {
    const listEmployeeCandidates = vi.fn(async () => [summary("file-1", "a勤怠管理表")]);
    const drive = { ...fakeDrive([], {}), listEmployeeCandidates };

    await createPeopleDirectory(drive).load(ACTOR);

    expect(listEmployeeCandidates).toHaveBeenCalledTimes(1);
  });
});
