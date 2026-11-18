import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { I18nContext } from "../../i18n/I18nContext";
import { MESSAGES } from "../../i18n/messages";
import { SessionStoreProvider } from "../../lib/sessionStore";
import * as tauriBridge from "../../lib/tauriBridge";
import { PasswordGeneratorWorkspace } from "./PasswordGeneratorWorkspace";

describe("D13 PasswordGeneratorWorkspace UI", () => {
  it("masks generated secrets by default, copies plaintext only on explicit click, marks stale on config edit, and supports passphrase mode", async () => {
    const user = userEvent.setup();
    let clipboardValue = "";
    const writeSpy = vi
      .spyOn(tauriBridge, "writeSystemClipboardText")
      .mockImplementation(async (val) => {
        clipboardValue = val;
      });

    render(
      <I18nContext.Provider value={{ locale: "zh-CN", t: MESSAGES["zh-CN"], setLocale: () => {} }}>
        <SessionStoreProvider>
          <PasswordGeneratorWorkspace />
        </SessionStoreProvider>
      </I18nContext.Provider>,
    );

    // 1. Generate default password batch -> masked by default, clipboard untouched
    await user.click(screen.getByRole("button", { name: "生成" }));
    await waitFor(() => expect(screen.getByTestId("secret-item-0")).toBeInTheDocument());
    expect(screen.getByTestId("secret-item-0").textContent).toMatch(/^•+$/);
    expect(writeSpy).not.toHaveBeenCalled();

    // 2. Explicit single-item copy writes real unmasked password to clipboard
    const copyButtons = screen.getAllByRole("button", { name: "复制" });
    await user.click(copyButtons[0]!);
    expect(clipboardValue.length).toBe(16);
    expect(clipboardValue).not.toContain("•");

    // 3. Reveal toggle displays plaintext, and editing length marks previous batch stale & disables copy
    await user.click(screen.getByRole("button", { name: "显示明文" }));
    expect(screen.getByTestId("secret-item-0").textContent).toBe(clipboardValue);

    const lenInput = screen.getByLabelText("密码长度 (8–128)");
    await user.clear(lenInput);
    await user.type(lenInput, "24");
    expect(screen.getByTestId("password-stale-banner")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /复制本批/ })).toBeDisabled();

    // 4. Switch to Passphrase mode, enable capitalize + 2-digit number, and regenerate
    await user.click(screen.getByRole("button", { name: "口令短语 (Passphrase)" }));
    await user.click(screen.getByLabelText("词首字母大写"));
    await user.click(screen.getByLabelText("末尾附加两位随机数字 (00–99)"));
    await user.click(screen.getByRole("button", { name: "重新生成" }));

    await waitFor(() =>
      expect(screen.queryByTestId("password-stale-banner")).not.toBeInTheDocument(),
    );
    const phrase = screen.getByTestId("secret-item-0").textContent ?? "";
    expect(phrase).toMatch(/^([A-Z][a-z]+-){6}\d{2}$/);

    writeSpy.mockRestore();
  });

  it("discards stale in-flight generations across config edits, clear, and out-of-order failures", async () => {
    const user = userEvent.setup();

    type SecretResp = Awaited<ReturnType<typeof tauriBridge.generateSecretsBatch>>;
    interface DeferredGen {
      resolve: (val: SecretResp) => void;
      reject: (err: unknown) => void;
    }
    const pendingCalls: DeferredGen[] = [];
    const genSpy = vi.spyOn(tauriBridge, "generateSecretsBatch").mockImplementation(
      () =>
        new Promise<SecretResp>((resolve, reject) => {
          pendingCalls.push({ resolve, reject });
        }),
    );

    const sampleStrength: SecretResp["strength"] = {
      estimatedBits: 47.6,
      isUpperBound: false,
      unconstrainedUpperBoundBits: 52.4,
      tier: "weak",
      modelKind: "constrained_all_selected_classes",
      poolSize: 83,
    };

    render(
      <I18nContext.Provider value={{ locale: "zh-CN", t: MESSAGES["zh-CN"], setLocale: () => {} }}>
        <SessionStoreProvider>
          <PasswordGeneratorWorkspace />
        </SessionStoreProvider>
      </I18nContext.Provider>,
    );

    const lenInput = screen.getByLabelText("密码长度 (8–128)");

    // 1. Configure 8-char password and start generation #1 (remains pending)
    await user.clear(lenInput);
    await user.type(lenInput, "8");
    await user.click(screen.getByRole("button", { name: "生成" }));
    expect(pendingCalls).toHaveLength(1);

    // User changes length to 128 before 8-char request returns
    await user.clear(lenInput);
    await user.type(lenInput, "128");

    // Old 8-char request resolves late -> must be discarded completely (never shown or copyable)
    pendingCalls[0]!.resolve({
      items: ["Ab3!xy7?", "Cd4@zw8*"],
      strength: sampleStrength,
    });
    await Promise.resolve();

    expect(screen.queryByTestId("secret-item-0")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: /复制本批/ })).toBeDisabled();

    // 2. Start generation #2 (128-char), then click Clear while in-flight -> late completion must NOT restore items
    await user.click(screen.getByRole("button", { name: "生成" }));
    expect(pendingCalls).toHaveLength(2);
    await user.click(screen.getByRole("button", { name: "清空" }));

    pendingCalls[1]!.resolve({
      items: ["X".repeat(128)],
      strength: { ...sampleStrength, estimatedBits: 815.2, tier: "very_strong" },
    });
    await Promise.resolve();
    expect(screen.queryByTestId("secret-item-0")).not.toBeInTheDocument();

    // 3. Start generation #3, edit length to 20, start generation #4; #3 fails while #4 is running
    await user.click(screen.getByRole("button", { name: "生成" }));
    expect(pendingCalls).toHaveLength(3);

    await user.clear(lenInput);
    await user.type(lenInput, "20");
    const genBtn = screen.getByRole("button", { name: "生成" });
    await user.click(genBtn);
    expect(pendingCalls).toHaveLength(4);
    expect(genBtn).toBeDisabled();

    // Old request #3 fails -> must NOT clear #4's loading state or surface a stale error
    pendingCalls[2]!.reject(new Error("STALE_RNG_FAILURE"));
    await Promise.resolve();
    expect(screen.queryByText(/STALE_RNG_FAILURE/)).not.toBeInTheDocument();
    expect(genBtn).toBeDisabled();

    // Request #4 succeeds -> 20-char batch becomes active and copyable
    pendingCalls[3]!.resolve({
      items: ["ValidTwentyChar#2026"],
      strength: { ...sampleStrength, estimatedBits: 127.0, tier: "very_strong" },
    });
    await waitFor(() => expect(screen.getByTestId("secret-item-0")).toBeInTheDocument());
    expect(screen.getByRole("button", { name: /复制本批/ })).not.toBeDisabled();

    genSpy.mockRestore();
  });
});
