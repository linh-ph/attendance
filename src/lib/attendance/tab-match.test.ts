import { describe, expect, test } from "vitest";
import { matchTabForEmail } from "./tab-match";

/**
 * The real tabs of `202608勤怠管理表`, which carries no configuration. The
 * account signed in as `linh.np@blended-asia.com` owns exactly one of them.
 */
const REAL_TABS = [
  { sheetId: "1468685976", title: "THAI GIA HAN" },
  { sheetId: "299837536", title: "NGUYEN PHAN LINH" },
  { sheetId: "448906253", title: "NGUYEN THI NHU HIEU" },
  { sheetId: "1547314109", title: "NGUYEN HO TRONG THAO" },
] as const;

describe("matchTabForEmail", () => {
  test("resolves the real workbook's tab from the real address", () => {
    expect(matchTabForEmail("linh.np@blended-asia.com", REAL_TABS)?.sheetId).toBe("299837536");
  });

  test("resolves every other colleague in that same file", () => {
    expect(matchTabForEmail("han.tg@blended-asia.com", REAL_TABS)?.title).toBe("THAI GIA HAN");
    expect(matchTabForEmail("hieu.ntn@blended-asia.com", REAL_TABS)?.title).toBe(
      "NGUYEN THI NHU HIEU",
    );
    expect(matchTabForEmail("thao.nht@blended-asia.com", REAL_TABS)?.title).toBe(
      "NGUYEN HO TRONG THAO",
    );
  });

  test("is case- and separator-insensitive on both sides", () => {
    expect(matchTabForEmail("Linh.NP@Blended-Asia.com", REAL_TABS)?.sheetId).toBe("299837536");
    expect(matchTabForEmail("linh_np@blended-asia.com", REAL_TABS)?.sheetId).toBe("299837536");
    expect(
      matchTabForEmail("linh.np@blended-asia.com", [
        { sheetId: "7", title: "  nguyen   phan  linh  " },
      ])?.sheetId,
    ).toBe("7");
  });

  test("ignores a plus-addressed suffix", () => {
    expect(matchTabForEmail("linh.np+payroll@blended-asia.com", REAL_TABS)?.sheetId).toBe(
      "299837536",
    );
  });

  test("matches a tab written with Vietnamese diacritics", () => {
    const tabs = [{ sheetId: "9", title: "NGUYỄN PHAN LINH" }];
    expect(matchTabForEmail("linh.np@blended-asia.com", tabs)?.sheetId).toBe("9");
  });

  test("matches when the address spells the whole name in any order", () => {
    const tabs = [{ sheetId: "3", title: "NGUYEN PHAN LINH" }];
    expect(matchTabForEmail("nguyen.phan.linh@blended-asia.com", tabs)?.sheetId).toBe("3");
    expect(matchTabForEmail("linh.nguyen.phan@blended-asia.com", tabs)?.sheetId).toBe("3");
  });

  test("refuses to guess when two tabs match equally well", () => {
    const twins = [
      { sheetId: "1", title: "NGUYEN PHAN LINH" },
      { sheetId: "2", title: "NGO PHAM LINH" },
    ];
    expect(matchTabForEmail("linh.np@blended-asia.com", twins)).toBeNull();
  });

  test("returns null when nothing matches, so the chooser still appears", () => {
    expect(matchTabForEmail("someone.else@blended-asia.com", REAL_TABS)).toBeNull();
    expect(matchTabForEmail("linh.np@blended-asia.com", [{ sheetId: "1", title: "勤怠" }])).toBeNull();
  });

  test("never matches a bare given name against a full name", () => {
    // `linh@…` says nothing about which Linh, so it must not silently open one.
    expect(matchTabForEmail("linh@blended-asia.com", REAL_TABS)).toBeNull();
  });

  test("treats an unusable address or an empty tab list as no match", () => {
    expect(matchTabForEmail("", REAL_TABS)).toBeNull();
    expect(matchTabForEmail("not-an-address", REAL_TABS)).toBeNull();
    expect(matchTabForEmail("linh.np@blended-asia.com", [])).toBeNull();
  });
});
