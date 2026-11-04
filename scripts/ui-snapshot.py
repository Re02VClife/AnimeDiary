"""UI 快照（多状态）：首页 / 卡片 hover / 详情 / 滚动 / 侧栏 / 批量 / 空状态 / 浅色。

用法：python scripts/ui-snapshot-full.py [url] [输出目录]
"""
import sys
from pathlib import Path
from playwright.sync_api import sync_playwright

url = sys.argv[1] if len(sys.argv) > 1 else "http://localhost:5199/"
out = Path(sys.argv[2] if len(sys.argv) > 2 else ".review/ui")
out.mkdir(parents=True, exist_ok=True)

errors: list[str] = []

with sync_playwright() as p:
    browser = p.chromium.launch(channel="msedge")
    ctx = browser.new_context(viewport={"width": 1600, "height": 950})
    page = ctx.new_page()
    page.on("console", lambda m: errors.append(f"{m.type}: {m.text}") if m.type == "error" else None)
    page.on("pageerror", lambda e: errors.append(f"pageerror: {e}"))
    page.goto(url, wait_until="networkidle")
    page.wait_for_timeout(4500)
    page.screenshot(path=str(out / "01-home.png"))

    # 卡片 hover
    card = page.query_selector(".anime-card")
    if card:
        card.hover()
        page.wait_for_timeout(700)
        page.screenshot(path=str(out / "03-card-hover.png"))

        # 打开详情
        card.click()
        page.wait_for_timeout(2200)
        page.screenshot(path=str(out / "04-detail.png"))
        close = page.query_selector(".anime-detail-modal .ant-modal-close")
        if close:
            close.click()
        page.wait_for_timeout(1000)

    # 滚动状态（sticky 顶栏）
    page.mouse.move(800, 600)
    page.mouse.wheel(0, 620)
    page.wait_for_timeout(1000)
    page.screenshot(path=str(out / "05-scrolled.png"))
    page.mouse.wheel(0, -1200)
    page.wait_for_timeout(700)

    # 侧栏展开
    brand = page.query_selector(".brand-trigger")
    if brand:
        brand.hover()
        page.wait_for_timeout(1200)
        page.screenshot(path=str(out / "02-sidebar.png"))

        # 批量模式
        try:
            page.locator(".sidebar-section button", has_text="批量添加").first.click()
            page.wait_for_timeout(600)
            page.mouse.move(1100, 500)
            page.wait_for_timeout(900)
            page.screenshot(path=str(out / "07-batch.png"))
        except Exception as exc:  # noqa: BLE001
            errors.append(f"batch: {exc}")

    # 重新加载，回到干净状态
    page.reload(wait_until="networkidle")
    page.wait_for_timeout(4000)

    # 空状态：搜索不存在的内容
    search = page.query_selector(".search-input input")
    if search:
        search.fill("zzzzz-no-such-anime")
        page.wait_for_timeout(900)
        page.screenshot(path=str(out / "06-empty.png"))
        search.fill("")
        page.wait_for_timeout(700)

    # 浅色主题
    page.evaluate(
        "localStorage.setItem('anime_diary_theme', JSON.stringify({themeMode:'light',customColors:{},catgirlMode:false,customIcons:{}}))"
    )
    page.reload(wait_until="networkidle")
    page.wait_for_timeout(4200)
    page.screenshot(path=str(out / "08-light.png"))

    browser.close()

print("saved to", out)
print("errors:", "\n".join(errors[:20]) if errors else "none")
