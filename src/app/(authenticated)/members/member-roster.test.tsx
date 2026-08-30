import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { createMemoryStore } from "@/lib/dashboard/local-store";
import type { DirectoryPerson } from "@/lib/directory/people-directory";
import { MemberRoster } from "./member-roster";

const EMAIL = "linh.np@blended-asia.com";

function stubDirectory(people: DirectoryPerson[], ok = true): void {
  vi.stubGlobal(
    "fetch",
    vi.fn(() => Promise.resolve({ ok, json: () => Promise.resolve({ people }) })),
  );
}

function addMember(name: string, email: string): void {
  fireEvent.change(screen.getByLabelText("Name"), { target: { value: name } });
  fireEvent.change(screen.getByLabelText("Email"), { target: { value: email } });
  fireEvent.click(screen.getByRole("button", { name: "Add member" }));
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("MemberRoster", () => {
  it("keeps a typed member, and has it back on the next visit", async () => {
    const store = createMemoryStore();
    const { unmount } = render(<MemberRoster email={EMAIL} store={store} />);

    await screen.findByLabelText("Name");
    addMember("THAI GIA HAN", "Han.TG@Blended-Asia.com");

    await screen.findByText("THAI GIA HAN");
    // Normalized on the way in: the address is the identity everywhere else.
    expect(screen.getByText("han.tg@blended-asia.com")).toBeInTheDocument();

    unmount();
    render(<MemberRoster email={EMAIL} store={store} />);

    await screen.findByText("THAI GIA HAN");
  });

  it("scopes the roster to the signed-in account", async () => {
    const store = createMemoryStore();
    const { unmount } = render(<MemberRoster email={EMAIL} store={store} />);

    await screen.findByLabelText("Name");
    addMember("THAI GIA HAN", "han.tg@blended-asia.com");
    await screen.findByText("THAI GIA HAN");

    unmount();
    render(<MemberRoster email="someone.else@blended-asia.com" store={store} />);

    await screen.findByText("No members yet.");
  });

  it.each([
    ["a missing name", "", "han.tg@blended-asia.com", "Enter the member's name."],
    ["a missing address", "THAI GIA HAN", "", "Enter the member's email address."],
    ["an address that is not one", "THAI GIA HAN", "han.tg", "Enter a valid email address."],
  ])("refuses %s", async (_case, name, address, message) => {
    const store = createMemoryStore();
    render(<MemberRoster email={EMAIL} store={store} />);

    await screen.findByLabelText("Name");
    addMember(name, address);

    expect(screen.getByRole("alert")).toHaveTextContent(message);
    expect(await store.readMembers(EMAIL)).toEqual([]);
  });

  it("removes a member", async () => {
    const store = createMemoryStore();
    render(<MemberRoster email={EMAIL} store={store} />);

    await screen.findByLabelText("Name");
    addMember("THAI GIA HAN", "han.tg@blended-asia.com");
    await screen.findByText("THAI GIA HAN");

    fireEvent.click(screen.getByRole("button", { name: "Remove THAI GIA HAN" }));

    await screen.findByText("No members yet.");
    expect(await store.readMembers(EMAIL)).toEqual([]);
  });

  it("offers the colleagues Drive reports, and adds only the one chosen", async () => {
    stubDirectory([
      { email: "han.tg@blended-asia.com", displayName: "THAI GIA HAN", fileCount: 3 },
      { email: "quynh.kt@blended-asia.com", displayName: null, fileCount: 1 },
    ]);
    const store = createMemoryStore();
    render(<MemberRoster email={EMAIL} store={store} />);

    await screen.findByLabelText("Name");
    fireEvent.click(screen.getByRole("button", { name: "Find colleagues" }));

    await screen.findByRole("button", { name: "Add THAI GIA HAN" });
    // Drive knew no name for this one, so the address stands in for it.
    expect(screen.getByRole("button", { name: "Add quynh.kt@blended-asia.com" })).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Add THAI GIA HAN" }));

    await waitFor(async () =>
      expect(await store.readMembers(EMAIL)).toEqual([
        { email: "han.tg@blended-asia.com", displayName: "THAI GIA HAN" },
      ]),
    );
  });

  it("does not offer somebody already on the roster", async () => {
    stubDirectory([
      { email: "han.tg@blended-asia.com", displayName: "THAI GIA HAN", fileCount: 3 },
    ]);
    const store = createMemoryStore();
    await store.addMember(EMAIL, { email: "han.tg@blended-asia.com", displayName: "THAI GIA HAN" });

    render(<MemberRoster email={EMAIL} store={store} />);
    await screen.findByText("THAI GIA HAN");

    fireEvent.click(screen.getByRole("button", { name: "Find colleagues" }));

    await screen.findByText("Everyone Drive knows about is already on your list.");
  });

  it("reports a failed import without emptying the roster", async () => {
    stubDirectory([], false);
    const store = createMemoryStore();
    await store.addMember(EMAIL, { email: "han.tg@blended-asia.com", displayName: "THAI GIA HAN" });

    render(<MemberRoster email={EMAIL} store={store} />);
    await screen.findByText("THAI GIA HAN");

    fireEvent.click(screen.getByRole("button", { name: "Find colleagues" }));

    await screen.findByText("Could not read who else can reach your attendance files.");
    expect(screen.getByText("THAI GIA HAN")).toBeInTheDocument();
  });
});
