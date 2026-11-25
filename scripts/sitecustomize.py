"""Sandbox-safe optional Python defaults for Docuflex's bundled helpers.

Python's system MIME scan includes /etc/apache2/mime.types on macOS. That
configuration is not needed for document conversion and is outside App Sandbox.
Keep the standard built-in mappings rather than granting access to /etc.
"""
import os

if os.environ.get('DOCUFLEX_SANDBOX') == '1':
    import mimetypes
    mimetypes.knownfiles = []
    mimetypes.init(files=[])
