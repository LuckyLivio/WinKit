"""Exercise the production F01 UI in a fresh Chromium context with external traffic blocked.

Build with npm run build. Install Python Playwright and its Chromium binary, then run
python tests/qr_offline_smoke.py. Pass --browser PATH to use an existing Chromium binary.
"""

import argparse
import json
import os
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from tempfile import TemporaryDirectory
from threading import Thread
from urllib.parse import urlsplit

from playwright.sync_api import expect, sync_playwright

ROOT = Path(__file__).resolve().parents[1]
FIXTURES = ROOT / "tests" / "fixtures" / "f01"


def check_reader(page, requests):
    # Generated independently with ReportLab. The WebP uses lossy VP8.
    samples = {
        "mixed.png": {
            "QR Code": "Independent QR sample",
            "Code 128": "WINKIT-128",
            "EAN-13": "5901234123457",
        },
        "code128.jpg": {"Code 128": "WINKIT-128"},
        "ean13.webp": {"EAN-13": "5901234123457"},
    }
    upload = page.locator('input[type="file"]')
    upload.set_input_files([FIXTURES / name for name in samples])
    expect(page.locator("pre.qr-code-content")).to_have_count(5)
    for name, results in samples.items():
        source = page.get_by_role("region", name=name)
        for kind, text in results.items():
            result = source.locator(".qr-code-result").filter(has_text=kind)
            expect(result.locator("pre")).to_have_text(text)

    assert any("zxing_reader-" in path and status == 200 for path, status in requests)
    assert any("decodeWorker-" in path and status == 200 for path, status in requests)
    upload.set_input_files({
        "name": "truncated.png",
        "mimeType": "image/png",
        "buffer": (FIXTURES / "mixed.png").read_bytes()[:37],
    })
    expect(page.get_by_text("图片已损坏或无法读取。", exact=True)).to_be_visible()


def check_generation(page, temp):
    def press(label):
        page.get_by_role("button", name=label, exact=True).click()

    def export_and_read():
        with page.expect_download() as download:
            press("保存 PNG")
        png = temp / "export.png"
        download.value.save_as(png)
        press("读取")
        page.locator('input[type="file"]').set_input_files(png)

    content = "中文离线验证🌐\n第二行"
    press("生成")
    press("文本")
    page.locator("textarea").fill(content)
    press("复制图片")
    expect(page.get_by_text("图片已复制。", exact=True)).to_be_visible()
    press("读取")
    press("粘贴剪贴板图片")
    result = page.locator("pre.qr-code-content")
    expect(result).to_have_text(content)
    assert result.text_content() == content  # Include the original newline.

    press("生成")
    press("Wi-Fi")
    page.get_by_label("网络名 (SSID)").fill("测试;网络")
    page.get_by_label("密码", exact=True).fill("key:123")
    page.get_by_label("隐藏网络").check()
    export_and_read()
    expect(result).to_have_text(r"WIFI:T:WPA;S:测试\;网络;P:key\:123;H:true;;")
    press("复制 Wi-Fi 密码")
    assert page.evaluate("navigator.clipboard.readText()") == "key:123"

    press("生成")
    page.get_by_label("安全类型").select_option("nopass")
    export_and_read()
    expect(result).to_have_text(r"WIFI:T:nopass;S:测试\;网络;H:true;;")
    expect(page.get_by_role("button", name="复制 Wi-Fi 密码")).to_have_count(0)


def run(browser_path, dist):
    if not (dist / "index.html").is_file():
        raise SystemExit("Build the frontend with npm run build before running the smoke test.")
    config = json.loads((ROOT / "src-tauri" / "tauri.conf.json").read_text(encoding="utf-8"))
    requests = []

    class Static(SimpleHTTPRequestHandler):
        def end_headers(self):
            self.send_header("Content-Security-Policy", config["app"]["security"]["csp"])
            self.send_header("Cache-Control", "no-store")
            super().end_headers()

        def log_request(self, code="-", size="-"):
            requests.append((self.path, code))

    handler = partial(Static, directory=str(dist))
    with ThreadingHTTPServer(("127.0.0.1", 0), handler) as server:
        Thread(target=server.serve_forever, daemon=True).start()
        origin = f"127.0.0.1:{server.server_port}"
        with TemporaryDirectory() as directory, sync_playwright() as playwright:
            browser = playwright.chromium.launch(
                executable_path=browser_path,
                headless=True,
                env={**os.environ, "XDG_CACHE_HOME": directory, "XDG_CONFIG_HOME": directory},
                args=["--disable-background-networking", "--proxy-server=http://127.0.0.1:1",
                      "--proxy-bypass-list=127.0.0.1"],
            )
            context = browser.new_context(
                service_workers="block", accept_downloads=True,
                permissions=["clipboard-read", "clipboard-write"],
            )
            external = []

            def allow_app_only(route):
                dest = urlsplit(route.request.url)
                if dest.scheme in ("http", "https") and dest.netloc != origin:
                    external.append(dest.netloc)
                    route.abort()
                else:
                    route.continue_()

            context.route("**/*", allow_app_only)
            page = context.new_page()
            page.set_default_timeout(15000)
            expect.set_options(timeout=15000)
            page.goto(f"http://{origin}/")
            page.locator(".tool-row-main").filter(has_text="F01").click()
            page.get_by_role("button", name="读取", exact=True).click()
            check_reader(page, requests)
            check_generation(page, Path(directory))
            assert not external, "Observed an external request during the offline workflow."
            browser.close()
        server.shutdown()
    print("F01 production offline smoke test passed.")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--browser", help="Path to an existing Chromium executable")
    parser.add_argument("--dist", type=Path, default=ROOT / "dist", help="Built frontend directory")
    options = parser.parse_args()
    run(options.browser, options.dist)
