import { fireEvent, render } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ButtonGroup, ToggleSwitch } from "./FormControls";

describe("FormControls", () => {
  it("disables button-group options for keyboard and pointer input", () => {
    const onChange = vi.fn();
    const { getByRole } = render(
      <ButtonGroup
        options={[{ value: "a", label: "A" }, { value: "b", label: "B" }]}
        value="a"
        onChange={onChange}
        disabled
      />,
    );

    const option = getByRole("button", { name: "B" });
    expect((option as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(option);
    expect(onChange).not.toHaveBeenCalled();
  });

  it("exposes switch state and an accessible name", () => {
    const { getByRole } = render(
      <ToggleSwitch enabled onToggle={() => {}} ariaLabel="Enable refresh" />,
    );
    expect(getByRole("switch", { name: "Enable refresh" }).getAttribute("aria-checked")).toBe("true");
  });
});
