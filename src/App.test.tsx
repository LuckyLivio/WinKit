import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { App } from "./App";

describe("WinKit bootstrap shell", () => {
  it("renders application title and runtime metadata cleanly", async () => {
    render(<App />);
    expect(screen.getByRole("heading", { name: "WinKit" })).toBeInTheDocument();
    expect(await screen.findByText(/WinKit v0\.1\.0/)).toBeInTheDocument();
  });
});
