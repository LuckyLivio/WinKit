import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { I18nContext } from "../../i18n/I18nContext";
import { MESSAGES } from "../../i18n/messages";
import { SessionStoreProvider } from "../../lib/sessionStore";
import * as tauriBridge from "../../lib/tauriBridge";
import { HashGeneratorWorkspace } from "./HashGeneratorWorkspace";

function renderHashWorkspace() {
  return render(
    <I18nContext.Provider value={{ locale: "zh-CN", t: MESSAGES["zh-CN"], setLocale: () => {} }}>
      <SessionStoreProvider>
        <HashGeneratorWorkspace />
      </SessionStoreProvider>
    </I18nContext.Provider>,
  );
}

describe("D03 HashGeneratorWorkspace UI (multi-algorithm)", () => {
  it("computes MD5 / SHA-1 / SHA-256 / SHA-384 / SHA-512 known vectors, shows MD5/SHA-1 compat notice, and verifies expected digests", async () => {
    const user = userEvent.setup();
    renderHashWorkspace();

    // Enable MD5 and SHA-512 alongside default SHA-256
    await user.click(screen.getByRole("button", { name: "MD5" }));
    await user.click(screen.getByRole("button", { name: "SHA-512" }));

    // Compatibility warning must be visible when MD5 or SHA-1 is enabled
    expect(screen.getByText(/不适用于密码存储/)).toBeInTheDocument();

    // Compute empty string digests first
    await user.click(screen.getByRole("button", { name: "重新计算" }));
    await waitFor(() =>
      expect(screen.getByTestId("digest-SHA-256")).toHaveTextContent(
        "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
      ),
    );
    expect(screen.getByTestId("digest-MD5")).toHaveTextContent("d41d8cd98f00b204e9800998ecf8427e");

    // Type "abc" and verify all 3 digests update accurately
    const input = screen.getByLabelText("待计算文本");
    await user.type(input, "abc");
    await waitFor(() =>
      expect(screen.getByTestId("digest-MD5")).toHaveTextContent(
        "900150983cd24fb0d6963f7d28e17f72",
      ),
    );
    expect(screen.getByTestId("digest-SHA-256")).toHaveTextContent(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    );

    // Expected compare: paste SHA-1 (40 hex) while SHA-1 is NOT selected -> informs candidate SHA-1 uncomputed
    const compareBox = screen.getByLabelText("期望摘要比对（可选）");
    await user.type(compareBox, "a9993e364706816aba3e25717850c26c9cd0d89d");
    expect(screen.getByText(/推断候选算法为 SHA-1/)).toBeInTheDocument();

    // Now click SHA-1 -> auto-computes SHA-1 in text mode and immediately matches!
    await user.click(screen.getByRole("button", { name: "SHA-1" }));
    await waitFor(() => expect(screen.getByText(/一致：与当前计算的 SHA-1/)).toBeInTheDocument());
  });

  it("clears stale digests on file task cancellation and marks needsRecompute when algorithms change", async () => {
    const user = userEvent.setup();
    vi.spyOn(tauriBridge, "pickSingleFile").mockResolvedValueOnce("D:\\sample.bin");
    vi.spyOn(tauriBridge, "computeFileHashes").mockResolvedValueOnce({
      taskId: "d03-1",
      path: "D:\\sample.bin",
      fileName: "sample.bin",
      byteLength: 3,
      digests: [
        {
          algorithm: "SHA-256",
          hexLength: 64,
          digestHex: "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
        },
      ],
    });

    renderHashWorkspace();
    await user.click(screen.getByRole("button", { name: "本地文件" }));
    await user.click(screen.getAllByRole("button", { name: /选择本地文件/ })[0]!);

    await waitFor(() => expect(screen.getByTestId("digest-SHA-256")).toHaveTextContent("ba7816bf"));

    // Selecting MD5 after file completion marks status as stale ("待重新计算") rather than showing stale success
    await user.click(screen.getByRole("button", { name: "MD5" }));
    expect(screen.getByText("待重新计算")).toBeInTheDocument();
    expect(screen.queryByTestId("digest-SHA-256")).not.toBeInTheDocument();

    // Now simulate cancelled recompute -> shows cancelled status and retains no digest
    vi.spyOn(tauriBridge, "computeFileHashes").mockRejectedValueOnce(
      JSON.stringify({ code: "TASK_CANCELLED", message: "Cancelled" }),
    );
    await user.click(screen.getByRole("button", { name: "重新计算" }));
    await waitFor(() => expect(screen.getAllByText(/计算已取消/).length).toBeGreaterThan(0));
  });
});
