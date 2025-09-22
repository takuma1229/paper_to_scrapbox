import os
import subprocess
import sys
import unittest
from pathlib import Path


RUN_NETWORK_TESTS = os.getenv("RUN_NETWORK_TESTS") == "1"
PROJECT_ROOT = Path(__file__).resolve().parent


@unittest.skipUnless(
    RUN_NETWORK_TESTS,
    "Set RUN_NETWORK_TESTS=1 to enable integration tests that hit external services.",
)
class PaperSummaryIntegrationTests(unittest.TestCase):
    urls = [
        "https://arxiv.org/abs/2509.16198",
        "https://aclanthology.org/2025.acl-long.66/",
        "https://openreview.net/forum?id=MVffKOFhuw&referrer=%5BAuthor+Console%5D%28%2Fgroup%3Fid%3Daclweb.org%2FACL%2F2025%2FSRW%2FAuthors%23your-submissions%29",
    ]

    def run_cli(self, url: str) -> subprocess.CompletedProcess[str]:
        env = os.environ.copy()
        env.setdefault("SCRAPBOX_BASE_URL", "https://example.com")
        env["SCRAPBOX_SKIP_BROWSER"] = "1"

        command = [
            sys.executable,
            "paper_summary.py",
            url,
            "integration-test-project",
            "--model",
            env.get("OPENAI_MODEL", "gpt-4o-mini"),
        ]

        return subprocess.run(
            command,
            cwd=str(PROJECT_ROOT),
            env=env,
            text=True,
            capture_output=True,
            check=True,
        )

    def test_all_urls_complete_successfully(self) -> None:
        failures = []
        for url in self.urls:
            try:
                result = self.run_cli(url)
            except subprocess.CalledProcessError as exc:  # pragma: no cover - integration
                failures.append((url, exc.stdout, exc.stderr))
                continue
            combined_output = (result.stdout or "") + ("\n" + result.stderr if result.stderr else "")
            self.assertRegex(
                combined_output,
                r"処理が完了しました|Done",
                msg=f"Expected completion marker in output for {url}"
            )

        if failures:
            details = "\n\n".join(
                f"URL: {url}\nSTDOUT:\n{stdout}\nSTDERR:\n{stderr}"
                for url, stdout, stderr in failures
            )
            self.fail(f"Some URLs failed:\n{details}")


if __name__ == "__main__":
    unittest.main()
