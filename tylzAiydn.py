"""
天翼量子AI云电脑 - 青龙面板自动登录脚本（浏览器版本）
平台: https://pc.ctyun.cn/#/login

使用说明:
  1. 推送模块: 支持 rnl_push.py / notify.py（与 WPS 签到脚本一致）
     也可自动调用青龙 sendNotify.js（三重兜底）
  2. 设置环境变量: TYLZ_AIYDN（多账号支持）
  3. 定时规则: */30 * * * *  （30分钟执行一次）
  注: 首次运行会自动安装 playwright + chromium，请耐心等待下载

环境变量格式:
  TYLZ_AIYDN=账号1#密码1&账号2#密码2
  # 或换行分隔:
  TYLZ_AIYDN=账号1#密码1
  账号2#密码2

  HEADLESS=true/false  是否无头模式（默认 true，调试时设 false）
  
推送通知设置:
  配置区域（约第99行）：
  ENABLE_NOTIFY = True
  True = 开启推送
  False = 关闭推送


"""

# ==================================================
# 自动安装依赖（首次运行或缺失时自动安装）
# ==================================================
import sys
import subprocess
import importlib.util


def ensure_playwright():
    """
    检测并自动安装 playwright + chromium。
    已安装则跳过，未安装则自动 pip install 并下载 chromium。
    """
    if importlib.util.find_spec("playwright") is None:
        print("🔧 检测到 playwright 未安装，正在自动安装...", flush=True)
        try:
            subprocess.check_call(
                [sys.executable, "-m", "pip", "install", "playwright"],
                stdout=sys.stdout,
                stderr=sys.stderr
            )
            print("✅ playwright 安装完成！", flush=True)
        except subprocess.CalledProcessError as e:
            print(f"❌ playwright 安装失败: {e}", flush=True)
            print("请手动执行: pip install playwright && playwright install chromium", flush=True)
            sys.exit(1)

    print("🔧 检查 Chromium 浏览器...", flush=True)
    try:
        subprocess.check_call(
            [sys.executable, "-m", "playwright", "install", "chromium"],
            stdout=sys.stdout,
            stderr=sys.stderr
        )
        print("✅ Chromium 就绪！", flush=True)
    except subprocess.CalledProcessError as e:
        print(f"⚠️ Chromium 安装异常: {e}", flush=True)
        print("将继续尝试运行，若失败请手动执行: playwright install chromium", flush=True)


ensure_playwright()

# ==================== 推送模块加载区 ====================
try:
    from rnl_push import rnl_push
except Exception:
    try:
        import notify
        if hasattr(notify, 'send'):
            notify.sendNotify = notify.send
        rnl_push = notify
    except Exception:
        rnl_push = None

import os
import time
import random
import re
import asyncio
import glob
import json
import urllib.request
import urllib.error

# ==================== 配置 ====================
RAW_ACCOUNTS = os.getenv("TYLZ_AIYDN", "")
HEADLESS = os.getenv("HEADLESS", "true").lower() == "true"
LOGIN_URL = "https://pc.ctyun.cn/#/login"

# 推送开关：True=开启推送，False=关闭推送（直接修改此处控制）
ENABLE_NOTIFY = False


# ==================== 账号解析 ====================
def parse_accounts(raw: str) -> list:
    parts = re.split(r"[&\n]+", raw.strip())
    accounts = []
    for part in parts:
        part = part.strip()
        if not part or "#" not in part:
            continue
        acc, pwd = part.split("#", 1)
        acc = acc.strip()
        pwd = pwd.strip()
        if acc and pwd:
            accounts.append((acc, pwd))
    return accounts


# ==================== 日志工具 ====================
def log(level: str, msg: str):
    from datetime import datetime
    ts = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
    color_map = {
        "INFO":   "\033[36m",
        "WARN":   "\033[33m",
        "ERROR":  "\033[31m",
        "成功":    "\033[32m",
    }
    reset = "\033[0m"
    c = color_map.get(level, "")
    print(f"[{ts}] {c}[{level}]{reset} {msg}")


def info(msg: str):    log("INFO",  msg)
def warn(msg: str):    log("WARN",  msg)
def error(msg: str):   log("ERROR", msg)
def success(msg: str): log("成功", msg)


def notify(title: str, content: str):
    """推送通知（通过脚本内 ENABLE_NOTIFY 变量控制）"""
    if not ENABLE_NOTIFY:
        info(f"[通知-关闭] 推送功能已关闭，跳过 -> {title}")
        return
    
    if rnl_push is not None:
        try:
            rnl_push.sendNotify(title, content)
            info(f"[通知] 已通过 rnl_push 模块推送 -> {title}")
            return
        except Exception as e:
            warn(f"rnl_push 推送失败: {e}，尝试 sendNotify.js ...")

    candidates = [
        "/ql/scripts/sendNotify.js",
        "/ql/scripts/notify/sendNotify.js",
        "/ql/scripts/sendNotify",
        "/etc/qinglong/scripts/sendNotify.js",
        "/usr/local/qinglong/scripts/sendNotify.js",
    ]
    try:
        found = glob.glob("/**/sendNotify.js", recursive=True)
        candidates.extend(found[:3])
    except Exception:
        pass

    for cmd_path in candidates:
        if os.path.isfile(cmd_path):
            try:
                subprocess.run(
                    ["node", cmd_path, title, content],
                    capture_output=True, text=True, timeout=15,
                )
                info(f"[通知] 已通过 sendNotify.js 推送 -> {title}")
                return
            except Exception:
                continue

    try:
        subprocess.run(
            ["node", "sendNotify.js", title, content],
            capture_output=True, text=True, timeout=10,
        )
        info("[通知] 已通过 PATH sendNotify.js 推送")
        return
    except Exception:
        pass

    info(f"[通知-回退] {title}: {content}")


def mask_account(account: str) -> str:
    if not account:
        return "***"
    if re.match(r"^\d+$", account):
        s = account
        return re.sub(r"(\d{3})\d{4}(\d+)", r"\1****\2", s)
    if "@" in account:
        name, domain = account.split("@", 1)
        return f"{name[:3]}***@{domain}"
    return account[:2] + "***" + account[-2:] if len(account) > 4 else "***"


def get_daily_emotional_text() -> str:
    """
    获取当日热门情感文案，优先调用免费API，失败则从内置库随机选取。
    """
    apis = [
        "https://api.52vmy.cn/api/wl/talk",
        "https://api.vvhan.com/api/dailyEnglish",
        "https://api.52vmy.cn/api/wl/yan",
    ]
    for api in apis:
        try:
            req = urllib.request.Request(api, headers={"User-Agent": "Mozilla/5.0"})
            with urllib.request.urlopen(req, timeout=5) as resp:
                data = resp.read().decode("utf-8", errors="ignore").strip()
            if data:
                try:
                    obj = json.loads(data)
                    # 过滤 API 错误响应（如 {"code": -1, "msg": "接口不存在"}）
                    if obj.get("code") == -1 or obj.get("code") == "-1":
                        continue
                    text = obj.get("data") or obj.get("text") or obj.get("content") or ""
                    if isinstance(text, str) and text:
                        return text
                except Exception:
                    pass
                # 防止非 JSON 的错误文本（如接口不存在、404 等）被当作文案返回
                if len(data) < 200 and "接口不存在" not in data and '"code"' not in data:
                    return data
        except Exception:
            continue

    fallback = [
        "生活原本沉闷，但跑起来就有风。",
        "所谓无底深渊，下去，也是前程万里。",
        "保持热爱，奔赴山海。",
        "愿所有的美好如期而至，愿所有的幸福不期而遇。",
        "每一步都算数，每一滴汗水都不会白流。",
        "星光不问赶路人，时光不负有心人。",
        "把所有的晦暗都留给过往，从今往后，凛冬散尽，星河长明。",
        "愿你眼中有星辰大海，心中有繁花似锦。",
        "所有的运气和惊喜，都来自于你的人品和善良。",
        "不乱于心，不困于情，不畏将来，不念过往。",
        "努力的意义，不是为了感动谁，而是为了拥有选择的权利。",
        "照亮我的，未必是太阳，也可能是我自己。",
        "心怀暖阳，无畏风霜。",
        "没有醒不来的早晨，只有不敢追的梦。",
        "万事开头难，然后中间难，最后结尾难，但终会值得。",
    ]
    return random.choice(fallback)


async def random_delay(min_s: float = 0.5, max_s: float = 1.5):
    await asyncio.sleep(random.uniform(min_s, max_s))


# ==================== 单账号登录流程 ====================
async def login_one_account(page, account: str, password: str, debug_dir: str) -> dict:
    result = {"account": account, "login_ok": False, "desktop_ok": False, "msg": ""}

    try:
        # Step1: 打开登录页
        info(f"[{mask_account(account)}] 正在打开登录页面...")
        try:
            await page.goto(LOGIN_URL, wait_until="networkidle", timeout=30000)
        except Exception:
            await page.goto(LOGIN_URL, wait_until="load", timeout=30000)
        await random_delay(1.0, 2.0)
        await page.screenshot(path=f"{debug_dir}/01_login_page.png")

        # Step2: 切换到「账号登录」标签
        info(f"[{mask_account(account)}] 切换到账号登录标签...")
        try:
            tab = page.locator("text=账号登录")
            if await tab.count() > 0:
                await tab.first.click()
                await random_delay(0.3, 0.6)
        except Exception:
            pass

        # Step3: 填写账号
        info(f"[{mask_account(account)}] 填写账号...")
        try:
            acc_input = page.locator('input[type="text"][placeholder*="手机号"]')
            if await acc_input.count() == 0:
                acc_input = page.locator('input[type="text"]').first
            else:
                acc_input = acc_input.first
            await acc_input.click()
            await random_delay(0.2, 0.5)
            await acc_input.press_sequentially(account, delay=random.randint(50, 150))
            success(f"[{mask_account(account)}] 账号填写完成")
        except Exception as e:
            raise RuntimeError(f"填写账号失败: {e}")

        await random_delay(0.5, 1.0)

        # Step4: 填写密码（增加等待密码框出现的逻辑）
        info(f"[{mask_account(account)}] 填写密码...")
        try:
            # 先等待密码输入框出现，避免页面未加载完找不到元素
            try:
                await page.wait_for_selector(
                    'input[type="password"], input[placeholder*="密码"]',
                    timeout=10000
                )
            except Exception:
                pass
            pwd_input = page.locator('input[type="password"]')
            if await pwd_input.count() == 0:
                pwd_input = page.locator('input[placeholder*="密码"]').first
            else:
                pwd_input = pwd_input.first
            await pwd_input.click()
            await random_delay(0.2, 0.5)
            await pwd_input.press_sequentially(password, delay=random.randint(30, 100))
            success(f"[{mask_account(account)}] 密码填写完成")
        except Exception as e:
            raise RuntimeError(f"填写密码失败: {e}")

        await random_delay(0.5, 1.0)

        # Step5: 点击登录按钮
        info(f"[{mask_account(account)}] 点击登录按钮...")
        try:
            login_btn = page.locator("button.btn-submit.btn-submit-pc")
            if await login_btn.count() == 0:
                login_btn = page.locator('button.el-button--primary:has-text("登录")').first
            else:
                login_btn = login_btn.first
            await login_btn.click()
            success(f"[{mask_account(account)}] 已点击登录按钮")
        except Exception as e:
            raise RuntimeError(f"点击登录按钮失败: {e}")

        # Step6: 等待登录结果
        info(f"[{mask_account(account)}] 等待登录响应...")
        await random_delay(2.0, 4.0)
        await page.screenshot(path=f"{debug_dir}/05_after_login.png")

        current_url = page.url
        info(f"[{mask_account(account)}] 当前 URL: {current_url}")

        if "login" in current_url.lower() and "logout" not in current_url.lower():
            try:
                err_el = page.locator(".el-message--error, .error-msg, [class*=error]").first
                if await err_el.count() > 0:
                    err_text = await err_el.text_content(timeout=3000)
                    raise RuntimeError(f"登录失败: {err_text}")
            except Exception:
                pass
            raise RuntimeError("登录后仍在登录页，可能密码错误或触发验证码")

        result["login_ok"] = True
        success(f"[{mask_account(account)}] 登录成功！")

        # Step7: 点击「进入AI云电脑」按钮
        info(f"[{mask_account(account)}] 等待桌面列表，准备点击「进入AI云电脑」...")
        await random_delay(2.0, 4.0)

        try:
            await page.wait_for_selector(
                "div.desktopcom-enter, .desktopcom-content",
                timeout=10000
            )
        except Exception:
            warn(f"[{mask_account(account)}] 等待桌面元素超时，继续尝试点击...")

        desktop_entered = False

        for selector in ["div.desktopcom-enter", ".desktopcom-enter"]:
            try:
                btn = page.locator(selector).first
                if await btn.count() > 0 and await btn.is_visible():
                    await btn.click()
                    success(f"[{mask_account(account)}] 已点击「进入AI云电脑」({selector})")
                    desktop_entered = True
                    break
            except Exception:
                continue

        if not desktop_entered:
            for text in ["进入AI云电脑", "进入AI", "进入"]:
                try:
                    btn = page.locator(f'button:has-text("{text}")').first
                    if await btn.count() > 0 and await btn.is_visible():
                        await btn.click()
                        success(f"[{mask_account(account)}] 已点击按钮(文本: {text})")
                        desktop_entered = True
                        break
                except Exception:
                    continue

        if not desktop_entered:
            try:
                btn = page.locator(".desktopcom-content button.el-button--primary").first
                if await btn.count() > 0 and await btn.is_visible():
                    await btn.click()
                    success(f"[{mask_account(account)}] 已点击进桌按钮(el-button-primary)")
                    desktop_entered = True
            except Exception:
                pass

        # 进桌后停留 10~30 秒
        await random_delay(10.0, 30.0)
        final_url = page.url
        await page.screenshot(path=f"{debug_dir}/07_after_enter.png")
        info(f"[{mask_account(account)}] 最终 URL: {final_url}")

        if desktop_entered or "desktop" in final_url.lower() or "client" in final_url.lower():
            result["desktop_ok"] = True
            success(f"[{mask_account(account)}] 全部完成！登录+进桌均成功")
        else:
            result["msg"] = "登录成功但进入桌面未完成（可能云电脑未开机）"
            warn(f"[{mask_account(account)}] 登录成功但进桌未完成")

    except Exception as e:
        result["msg"] = str(e)
        error(f"[{mask_account(account)}] 失败: {e}")
        try:
            await page.screenshot(path=f"{debug_dir}/99_exception.png")
        except Exception:
            pass

    return result


# ==================== 主流程 ====================
async def main():
    # ⬇️ 启动后随机延迟 10~120 秒再开始
    import random as _r
    startup_delay = _r.uniform(10, 120)  # 10秒~120秒
    info(f"⏰ 启动延迟中，预计 {startup_delay:.0f} 秒后开始执行...")
    await asyncio.sleep(startup_delay)
    
    sep = "=" * 50
    info(sep)
    import base64 as _b; _s=_b.b64decode("5p2l5rqQ5YWs5LyX5Y+377ya6JGj5bCP5Z2b").decode()
    info(_s)
    info("  天翼量子AI云电脑 自动登录脚本 (浏览器版)")
    info(sep)

    accounts = parse_accounts(RAW_ACCOUNTS)

    if not accounts:
        error("未检测到账号信息！")
        error("请在青龙面板环境变量中设置 TYLZ_AIYDN")
        error("格式: 账号1#密码1&账号2#密码2  （多账号用 & 或换行分隔）")
        notify("天翼云电脑登录失败", "未配置 TYLZ_AIYDN 环境变量")
        sys.exit(1)

    info(f"共检测到 {len(accounts)} 个账号，开始逐个登录...")
    for _ in range(3): info(_s)

    try:
        from playwright.async_api import async_playwright
    except ImportError:
        error("缺少依赖，请在容器终端执行:")
        error("  pip install playwright && playwright install chromium")
        sys.exit(1)

    results = []

    debug_dir = "/tmp/ctyun_debug"
    try:
        os.makedirs(debug_dir, exist_ok=True)
    except Exception:
        pass

    for idx, (account, password) in enumerate(accounts, 1):
        info("")
        info("-" * 50)
        info(f"[{idx}/{len(accounts)}] 正在处理账号: {mask_account(account)}")
        info("-" * 50)

        async with async_playwright() as p:
            info(f"启动浏览器 (headless={HEADLESS})...")
            info(_s)
            browser = await p.chromium.launch(
                headless=HEADLESS,
                args=[
                    "--disable-blink-features=AutomationControlled",
                    "--no-sandbox",
                    "--disable-dev-shm-usage",
                    "--window-size=1280,800",
                ]
            )

            context = await browser.new_context(
                viewport={"width": 1280, "height": 800},
                user_agent=(
                    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
                    "AppleWebKit/537.36 (KHTML, like Gecko) "
                    "Chrome/120.0.0.0 Safari/537.36"
                ),
                locale="zh-CN",
            )
            page = await context.new_page()
            await page.add_init_script("""
                Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
                Object.defineProperty(navigator, 'plugins', { get: () => [1, 2, 3, 4, 5] });
                window.chrome = { runtime: {} };
            """)

            result = await login_one_account(page, account, password, debug_dir)
            results.append(result)

            await context.close()
            await browser.close()
            info("浏览器已关闭")

        # 账号间随机延迟 50~300 秒
        if idx < len(accounts):
            delay = random.uniform(50.0, 300.0)
            info(f"⏰等待 {delay:.1f}s 后处理下一个账号...")
            await asyncio.sleep(delay)

    # ==================== 汇总报告 ====================
    info("")
    info("=" * 50)
    info("  执行完毕 - 汇总报告")
    info("=" * 50)

    ok_login = [r for r in results if r["login_ok"]]
    ok_desktop = [r for r in results if r["desktop_ok"]]
    fail_all = [r for r in results if not r["login_ok"]]

    for r in results:
        acc = mask_account(r["account"])
        if r["desktop_ok"]:
            status = "登录 ✅ 进入桌面 ✅"
        elif r["login_ok"]:
            status = "登录 ✅ 进桌未完成 ⚠️"
        else:
            status = f"失败: {r['msg'][:40]}"
        info(f"  {acc}: {status}")

    info(f"\n统计: 共{len(results)}个 | 登录成功{len(ok_login)} | 进桌成功{len(ok_desktop)} | 失败{len(fail_all)}")

    # ==================== 组装推送内容 ====================
    from datetime import datetime
    now = datetime.now()
    finish_time = now.strftime("%Y年%m月%d日 %H:%M")

    total = len(results)
    login_str = f"登录: {len(ok_login)}/{total}"
    desktop_str = f"进桌: {len(ok_desktop)}/{total}"

    if len(fail_all) == 0:
        title = f"天翼云电脑全部成功 ✅"
    elif len(ok_login) == 0:
        title = f"天翼云电脑全部失败 ❌"
    else:
        title = f"天翼云电脑部分失败 ⚠️"

    # 详情行
    detail_lines = []
    for r in results:
        acc = mask_account(r["account"])
        if r["desktop_ok"]:
            detail_lines.append(f"{acc}: 登录✅ 进桌✅")
        elif r["login_ok"]:
            detail_lines.append(f"{acc}: 登录✅ 进桌⚠️")
        else:
            detail_lines.append(f"{acc}: 失败 - {r['msg'][:30]}")

    # 获取当日情感文案
    emotional_text = get_daily_emotional_text()

    # 组装内容，避免 f-string 内反斜杠
    detail_str = ""
    if detail_lines:
        detail_str = "\n       ".join(detail_lines)
        detail_block = f"      详情:\n       {detail_str}\n"
    else:
        detail_block = ""

    content = (
        f"完成时间：{finish_time}\n"
        f"内容: 共 {total} 个账号\n"
        f"      {login_str}\n"
        f"      {desktop_str}\n"
        f"{detail_block}"
        f"\n{emotional_text}"
    )

    notify(title, content)


if __name__ == "__main__":
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        info("用户中断，退出。")
        sys.exit(0)
    except Exception as e:
        error(f"脚本异常退出: {e}")
        sys.exit(1)