import { describe, expect, it, vi } from "vitest";
import { refreshGoogleToken, type GoogleToken } from "./google-token";

const expiredToken: GoogleToken = {
  accessToken: "old-access",
  refreshToken: "refresh-1",
  expiresAt: 1_787_999_999_999,
};

describe("refreshGoogleToken", () => {
  it("returns an unexpired token unchanged", async () => {
    const fetch = vi.fn();
    const token: GoogleToken = { ...expiredToken, expiresAt: 1_788_000_000_001 };

    await expect(refreshGoogleToken(token, fetch, () => 1_788_000_000_000)).resolves.toBe(token);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("refreshes an expired token and retains the original refresh token", async () => {
    const fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ access_token: "new-access", expires_in: 3600 }),
    });
    const token = {
      ...expiredToken,
      email: "manager@blended-asia.com",
      name: "Attendance Manager",
      sub: "google-subject",
      error: "RefreshAccessTokenError" as const,
    };

    await expect(
      refreshGoogleToken(token, fetch, () => 1_788_000_000_000),
    ).resolves.toEqual({
      email: "manager@blended-asia.com",
      name: "Attendance Manager",
      sub: "google-subject",
      accessToken: "new-access",
      refreshToken: "refresh-1",
      expiresAt: 1_788_003_600_000,
    });

    expect(fetch).toHaveBeenCalledWith(
      "https://oauth2.googleapis.com/token",
      expect.objectContaining({ method: "POST" }),
    );
    expect(fetch.mock.calls[0]?.[1]?.body).toContain("refresh_token=refresh-1");
  });

  it("returns a stable error when refresh fails or no refresh token exists", async () => {
    const fetch = vi.fn().mockResolvedValue({ ok: false, json: async () => ({}) });

    await expect(refreshGoogleToken(expiredToken, fetch, () => 1_788_000_000_000)).resolves.toMatchObject({
      error: "RefreshAccessTokenError",
    });
    await expect(
      refreshGoogleToken({ accessToken: "old-access", expiresAt: 0 }, fetch, () => 1),
    ).resolves.toMatchObject({ error: "RefreshAccessTokenError" });
  });
});
