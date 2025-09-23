import unittest
from unittest.mock import Mock, patch

from paper_summary import find_pdf_url


class FindPdfUrlTests(unittest.TestCase):
    def _mock_response(self, html: str) -> Mock:
        response = Mock()
        response.text = html
        response.raise_for_status = Mock()
        return response

    def test_finds_direct_pdf_link(self) -> None:
        html = """
        <html>
            <body>
                <a href=\"/papers/example.pdf\">Download PDF</a>
            </body>
        </html>
        """

        with patch("paper_summary.requests.get", return_value=self._mock_response(html)) as mocked_get:
            pdf_url = find_pdf_url("https://example.com/articles/123")

        mocked_get.assert_called_once()
        args, kwargs = mocked_get.call_args
        self.assertEqual(args[0], "https://example.com/articles/123")
        self.assertEqual(kwargs.get("timeout"), 30)
        self.assertIn("User-Agent", kwargs.get("headers", {}))
        self.assertEqual(pdf_url, "https://example.com/papers/example.pdf")

    def test_handles_arxiv_like_pdf_link_without_extension(self) -> None:
        html = """
        <html>
            <body>
                <a href=\"/pdf/2509.16198\">PDF</a>
            </body>
        </html>
        """

        with patch("paper_summary.requests.get", return_value=self._mock_response(html)):
            pdf_url = find_pdf_url("https://arxiv.org/abs/2509.16198")

        self.assertEqual(pdf_url, "https://arxiv.org/pdf/2509.16198.pdf")

    def test_uses_meta_tag_as_fallback(self) -> None:
        html = """
        <html>
            <head>
                <meta name=\"citation_pdf_url\" content=\"/downloads/paper_v2.pdf\" />
            </head>
            <body></body>
        </html>
        """

        with patch("paper_summary.requests.get", return_value=self._mock_response(html)):
            pdf_url = find_pdf_url("https://example.org/info/456")

        self.assertEqual(pdf_url, "https://example.org/downloads/paper_v2.pdf")

    def test_returns_same_url_when_page_url_is_pdf(self) -> None:
        url = "https://aclanthology.org/2025.acl-long.192.pdf"

        with patch("paper_summary.requests.get") as mocked_get:
            pdf_url = find_pdf_url(url)

        mocked_get.assert_not_called()
        self.assertEqual(pdf_url, url)


if __name__ == "__main__":
    unittest.main()
