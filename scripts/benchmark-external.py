#!/usr/bin/env python3
"""External anti-bot and browser fingerprint benchmark for patched Chromium 157."""
from __future__ import annotations

import json
import os
from pathlib import Path
import re
import sys
import time
from typing import Any

from invisible_chromium import DesktopHardwareProfile, InvisibleChromium


def _safe_step(name: str, fn: Any) -> dict[str, Any]:
    t0 = time.monotonic()
    try:
        data = fn()
        return {
            "status": "ok",
            "elapsed_s": round(time.monotonic() - t0, 2),
            "data": data,
        }
    except Exception as exc:
        return {
            "status": "error",
            "elapsed_s": round(time.monotonic() - t0, 2),
            "error": f"{type(exc).__name__}: {exc}",
        }


def main() -> int:
    out_path = Path(
        os.environ.get(
            "BENCHMARK_OUT",
            "chromium_patch/evidence/external-benchmark-157.0.8103.50.json",
        )
    )
    shots_dir = out_path.parent / "screenshots-157"
    shots_dir.mkdir(parents=True, exist_ok=True)

    seed = int(os.environ.get("BENCHMARK_SEED", "42"))
    tz_setting = os.environ.get("BENCHMARK_TIMEZONE", "auto")
    profile = DesktopHardwareProfile()  # Canonical 8-core / 8 GiB / UHD 630 Mesa OpenGL 4.6

    results: dict[str, Any] = {
        "seed": seed,
        "profile": profile.to_dict(),
        "timestamp_utc": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "sites": {},
    }

    with InvisibleChromium(
        seed=seed,
        headless=True,
        profile=profile,
        locale="en-US",
        timezone_id=tz_setting,
    ) as browser:
        results["resolved_timezone"] = browser.resolved_timezone
        results["browser_version"] = browser.version
        page = browser.new_page()

        # 1. Rebrowser Bot Detector
        def run_rebrowser() -> dict[str, Any]:
            page.goto("https://bot-detector.rebrowser.net/", timeout=35.0)
            time.sleep(2.5)
            _ = page.locator("body").is_visible()
            _ = page.evaluate("window.dummyFn && window.dummyFn()")
            time.sleep(1.5)
            page.screenshot(path=shots_dir / "rebrowser.png")
            rows = page.evaluate_isolated(
                """() => {
                  const items = [];
                  for (const tr of document.querySelectorAll('table tbody tr')) {
                    const tds = Array.from(tr.querySelectorAll('td')).map(el => el.innerText.trim());
                    if (tds.length >= 2) items.push({ test: tds[0], status: tds[1], notes: tds[2] || '' });
                  }
                  return items;
                }"""
            )
            return {"checks": rows}

        results["sites"]["rebrowser"] = _safe_step("rebrowser", run_rebrowser)
        print("rebrowser:", results["sites"]["rebrowser"]["status"], flush=True)

        # 2. Sannysoft Bot Test
        def run_sannysoft() -> dict[str, Any]:
            page.goto("https://bot.sannysoft.com/", timeout=35.0)
            time.sleep(3.5)
            page.screenshot(path=shots_dir / "sannysoft.png")
            rows = page.evaluate_isolated(
                """() => {
                  const out = {};
                  for (const tr of document.querySelectorAll('table tr')) {
                    const tds = tr.querySelectorAll('td');
                    if (tds.length >= 2) {
                      const key = tds[0].innerText.trim();
                      const val = tds[1].innerText.trim();
                      const failed = tds[1].classList.contains('failed');
                      if (key) out[key] = { value: val.slice(0, 160), failed };
                    }
                  }
                  return out;
                }"""
            )
            failed_keys = [k for k, v in rows.items() if v.get("failed")]
            return {"total_checks": len(rows), "failed_count": len(failed_keys), "failed_keys": failed_keys, "checks": rows}

        results["sites"]["sannysoft"] = _safe_step("sannysoft", run_sannysoft)
        print("sannysoft:", results["sites"]["sannysoft"]["status"], flush=True)

        # 3. CreepJS
        def run_creepjs() -> dict[str, Any]:
            page.goto("https://abrahamjuliot.github.io/creepjs/", timeout=45.0)
            deadline = time.monotonic() + 30.0
            while time.monotonic() < deadline:
                fp_text = page.evaluate_isolated(
                    "document.getElementById('fingerprint-data')?.innerText || ''"
                )
                if "like headless" in fp_text and "%" in fp_text:
                    break
                time.sleep(1.0)
            time.sleep(2.0)
            page.screenshot(path=shots_dir / "creepjs.png")
            raw = page.evaluate_isolated(
                """() => {
                  const text = document.getElementById('fingerprint-data')?.innerText || '';
                  const lines = text.split('\\n').map(s => s.trim()).filter(Boolean);
                  const headlessLines = lines.filter(l => /headless|stealth|chromium/i.test(l)).slice(0, 15);
                  let modalText = '';
                  for (const el of document.querySelectorAll('#fingerprint-data div')) {
                    const tc = el.textContent || '';
                    if (tc.includes('prefersLightColor') && tc.includes('noTaskbar')) {
                      modalText = tc;
                    }
                  }
                  return {
                    fpId: document.querySelector('.ellipsis-all')?.innerText?.trim() || null,
                    summaryLines: headlessLines,
                    modalText,
                  };
                }"""
            )
            flags = dict(re.findall(r"([a-zA-Z]+):\s*(true|false)", raw.get("modalText", "")))
            return {
                "fpId": raw["fpId"],
                "summaryLines": raw["summaryLines"],
                "likeHeadlessFlags": {k: (v == "true") for k, v in flags.items()},
            }

        results["sites"]["creepjs"] = _safe_step("creepjs", run_creepjs)
        print("creepjs:", results["sites"]["creepjs"]["status"], flush=True)

        # 4. Antcpt Google reCAPTCHA v3 Score Detector
        def run_recaptcha_v3() -> dict[str, Any]:
            page.goto("https://antcpt.com/score_detector/", timeout=40.0)
            time.sleep(2.0)
            page.mouse.move(320, 260)
            page.mouse.wheel(0, 180)
            page.mouse.move(520, 340)
            deadline = time.monotonic() + 25.0
            score_val = None
            score_line = ""
            while time.monotonic() < deadline:
                body_txt = page.evaluate_isolated("document.body.innerText")
                m = re.search(r"Your score is:\s*([0-9.]+)", body_txt)
                if m:
                    score_val = float(m.group(1))
                    score_line = m.group(0)
                    break
                time.sleep(1.5)
            page.screenshot(path=shots_dir / "recaptcha_v3.png")
            return {"score": score_val, "scoreLine": score_line}

        results["sites"]["recaptcha_v3"] = _safe_step("recaptcha_v3", run_recaptcha_v3)
        print("recaptcha_v3:", results["sites"]["recaptcha_v3"], flush=True)

        # 5. BrowserLeaks (TLS/JA4 + WebGL + WebRTC)
        def run_browserleaks() -> dict[str, Any]:
            out: dict[str, Any] = {}
            page.goto("https://tls.browserleaks.com/json", timeout=30.0)
            out["tls"] = page.evaluate("JSON.parse(document.body.innerText)")

            page.goto("https://browserleaks.com/webgl", timeout=35.0)
            time.sleep(2.5)
            out["webgl"] = page.evaluate_isolated(
                """() => {
                  const rows = {};
                  for (const tr of document.querySelectorAll('table tr')) {
                    const tds = tr.querySelectorAll('td');
                    if (tds.length >= 2) {
                      const k = tds[0].innerText.trim();
                      const v = tds[1].innerText.trim();
                      if (k && /vendor|renderer|version|shading|context|caveat/i.test(k)) {
                        rows[k] = v.slice(0, 140);
                      }
                    }
                  }
                  return rows;
                }"""
            )

            page.goto("https://browserleaks.com/webrtc", timeout=35.0)
            time.sleep(3.0)
            out["webrtc"] = page.evaluate_isolated(
                """() => {
                  const rows = {};
                  for (const tr of document.querySelectorAll('table tr')) {
                    const tds = tr.querySelectorAll('td');
                    if (tds.length >= 2) {
                      const k = tds[0].innerText.trim();
                      const v = tds[1].innerText.trim();
                      if (k && /leak|local|public|rtc|ipv4|ipv6/i.test(k)) {
                        rows[k] = /public|ipv4|ipv6/i.test(k) ? '<redacted>' : v.slice(0, 140);
                      }
                    }
                  }
                  return rows;
                }"""
            )
            return out

        results["sites"]["browserleaks"] = _safe_step("browserleaks", run_browserleaks)
        print("browserleaks:", results["sites"]["browserleaks"]["status"], flush=True)

        # 6. Fingerprint.com Playground (Server-side Smart Signals)
        def run_fingerprint_pro() -> dict[str, Any]:
            page.goto("https://demo.fingerprint.com/playground", timeout=45.0)
            page.mouse.move(480, 320)
            deadline = time.monotonic() + 25.0
            body_txt = ""
            while time.monotonic() < deadline:
                body_txt = page.evaluate_isolated("document.body.innerText")
                if "Suspect Score" in body_txt and "Server API Response" in body_txt:
                    break
                time.sleep(1.5)
            page.screenshot(path=shots_dir / "fingerprint_pro.png")
            signals: dict[str, str] = {}
            lines = [ln.strip() for ln in body_txt.splitlines() if ln.strip()]
            wanted = {
                "Browser",
                "Operating System",
                "Confidence Score",
                "Incognito Mode",
                "Bot",
                "VPN",
                "Browser Tampering",
                "Developer Tools",
                "Virtual Machine",
                "Privacy Settings",
                "IP Blocklist",
                "Proxy Detection",
                "High-Activity Device",
                "Rare Device",
                "Suspect Score",
            }
            for i, ln in enumerate(lines[:-1]):
                if ln in wanted and ln not in signals:
                    signals[ln] = lines[i + 1]
            return {"smartSignals": signals}

        results["sites"]["fingerprint_pro"] = _safe_step("fingerprint_pro", run_fingerprint_pro)
        print("fingerprint_pro:", json.dumps(results["sites"]["fingerprint_pro"]), flush=True)

    out_path.parent.mkdir(parents=True, exist_ok=True)
    out_path.write_text(json.dumps(results, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    print(f"Wrote benchmark report to {out_path}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
