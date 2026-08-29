import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { DashboardLists } from "@/lib/dashboard/link-resolver";
import { createMemoryStore } from "@/lib/dashboard/local-store";
import { NO_ACCESS_MESSAGE, NOT_A_LINK_MESSAGE, OpenByLink } from "./open-by-link";

const FILE_ID = "1SheetFile_AbCdEfGhIjKlMnOpQrStUvWxYz01234";

const lists: DashboardLists = {
  managed: [],
  timesheets: [
    {
      id: FILE_ID,
      name: "202607勤怠管理表",
      ownerEmail: "manager@blended-asia.com",
      month: "2026-07",
      modifiedTime: null,
      sheetId: "101",
      sheetTitle: "NGUYEN PHAN LINH",
      tabs: [{ sheetId: "101", title: "NGUYEN PHAN LINH" }],
    },
  ],
};

function paste(value: string, navigate = vi.fn(), store = createMemoryStore()) {
  render(
    <OpenByLink email="linh.np@blended-asia.com" lists={lists} store={store} navigate={navigate} />,
  );

  fireEvent.change(screen.getByLabelText("Open by Google Sheets link"), { target: { value } });
  fireEvent.click(screen.getByRole("button", { name: "Open" }));

  return { navigate, store };
}

describe("OpenByLink", () => {
  it("navigates to the mapped sheet for a link the dashboard listed", async () => {
    const { navigate } = paste(`https://docs.google.com/spreadsheets/d/${FILE_ID}/edit`);

    await waitFor(() =>
      expect(navigate).toHaveBeenCalledWith(`/files/${FILE_ID}/attendance/101`),
    );
  });

  it("tells the user plainly when they have no permission, and does not navigate", async () => {
    const { navigate } = paste(
      "https://docs.google.com/spreadsheets/d/1SomeoneElses_AbCdEfGhIjKlMnOpQrStUvWxYz01/edit",
    );

    expect(await screen.findByRole("alert")).toHaveTextContent(NO_ACCESS_MESSAGE);
    expect(navigate).not.toHaveBeenCalled();
  });

  it("rejects something that is not a Google Sheets link", async () => {
    const { navigate } = paste("https://evildocs.google.com/spreadsheets/d/whatever12345");

    expect(await screen.findByRole("alert")).toHaveTextContent(NOT_A_LINK_MESSAGE);
    expect(navigate).not.toHaveBeenCalled();
  });

  it("remembers the visit so it can be offered again later", async () => {
    const { store } = paste(`https://docs.google.com/spreadsheets/d/${FILE_ID}/edit`);

    await waitFor(async () =>
      expect(await store.readRecent("linh.np@blended-asia.com")).toHaveLength(1),
    );

    const recent = await store.readRecent("linh.np@blended-asia.com");
    expect(recent[0]).toMatchObject({ fileId: FILE_ID, sheetId: "101" });
  });

  it("still navigates when the local store cannot record the visit", async () => {
    const failing = createMemoryStore();
    failing.addRecent = () => Promise.reject(new Error("storage disabled"));

    const { navigate } = paste(
      `https://docs.google.com/spreadsheets/d/${FILE_ID}/edit`,
      vi.fn(),
      failing,
    );

    await waitFor(() =>
      expect(navigate).toHaveBeenCalledWith(`/files/${FILE_ID}/attendance/101`),
    );
  });
});
