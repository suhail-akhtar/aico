"""Response headers every reply carries (OWASP HTTP Headers cheat sheet).

Kept apart from the middleware so the 500 handler, which runs outside the
middleware stack, can add the same headers without an import cycle.
"""

# OWASP HTTP Headers cheat sheet. The API returns JSON only, so the CSP is the
# strictest possible; the interactive docs page is exempted (it loads scripts).
SECURITY_HEADERS: dict[str, str] = {
    "x-content-type-options": "nosniff",
    "x-frame-options": "DENY",
    "referrer-policy": "strict-origin-when-cross-origin",
    "permissions-policy": (
        "accelerometer=(), camera=(), geolocation=(), gyroscope=(), microphone=(), "
        "payment=(), usb=()"
    ),
    "cross-origin-opener-policy": "same-origin",
    "content-security-policy": "default-src 'none'; frame-ancestors 'none'",
    "cache-control": "no-store",
}
HSTS = "max-age=63072000; includeSubDomains"
