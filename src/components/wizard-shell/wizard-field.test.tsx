import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { WizardField, WizardItem, WizardItemList } from "./wizard-field";

describe("WizardField", () => {
  it("binds the hint and the error to the control it belongs to", () => {
    render(
      <WizardField
        id="file-name"
        label="File name"
        hint="Include 勤怠管理表 so the file stays discoverable in Drive."
        error="Enter a file name."
      >
        {(control) => <input type="text" {...control} />}
      </WizardField>,
    );

    const input = screen.getByLabelText("File name");
    expect(input).toHaveAttribute("aria-invalid", "true");

    const described = (input.getAttribute("aria-describedby") ?? "").split(" ");
    expect(described).toContain("file-name-hint");
    expect(described).toContain("file-name-error");

    expect(document.getElementById("file-name-error")).toHaveTextContent("Enter a file name.");
    expect(document.getElementById("file-name-hint")).toHaveTextContent("勤怠管理表");
  });

  it("leaves a valid control unmarked, so the styling and the announcement agree", () => {
    render(
      <WizardField id="month" label="Month" hint="Any month you have not created yet.">
        {(control) => <input type="text" {...control} />}
      </WizardField>,
    );

    const input = screen.getByLabelText("Month");
    expect(input).not.toHaveAttribute("aria-invalid");
    expect(input).toHaveAttribute("aria-describedby", "month-hint");
    expect(document.getElementById("month-error")).toBeNull();
  });

  it("describes nothing when there is nothing to describe", () => {
    render(
      <WizardField id="folder" label="Destination folder">
        {(control) => <input type="text" {...control} />}
      </WizardField>,
    );

    expect(screen.getByLabelText("Destination folder")).not.toHaveAttribute("aria-describedby");
  });
});

describe("WizardItem", () => {
  it("keeps an item's failure beside that item rather than in a list at the top", () => {
    render(
      <WizardItemList label="Sheet owners">
        <WizardItem id="sheet-1" title="NGUYEN PHAN LINH">
          <p>31 attendance rows</p>
        </WizardItem>
        <WizardItem id="sheet-2" title="TRAN THI ANH" error="Enter a valid email address.">
          <p>31 attendance rows</p>
        </WizardItem>
      </WizardItemList>
    );

    const items = screen.getAllByRole("listitem");
    expect(items).toHaveLength(2);

    expect(items[0]).not.toHaveAttribute("aria-describedby");
    expect(items[1]).toHaveAttribute("aria-describedby", "sheet-2-error");
    expect(items[1]).toHaveTextContent("Enter a valid email address.");
    // The message is inside the failing row, not hoisted out of it.
    expect(items[1].querySelector("#sheet-2-error")).not.toBeNull();
    expect(items[0].querySelector(".field-error")).toBeNull();
  });
});
