"""The HTTP round-trip tests need the pytest-httpserver plugin from the dev extra. Without it,
a bare `pip install -e . && pytest` used to error with "fixture 'httpserver' not found"; now
those tests skip with the install command and the offline tests still run.
"""

import pytest

try:
    import pytest_httpserver  # noqa: F401
except ImportError:

    @pytest.fixture
    def httpserver():
        pytest.skip('needs pytest-httpserver: pip install -e ".[dev]"')
